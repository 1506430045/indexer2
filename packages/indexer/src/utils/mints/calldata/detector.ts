import { AddressZero } from "@ethersproject/constants";
import { formatEther } from "@ethersproject/units";
import * as Sdk from "@reservoir0x/sdk";

import { idb } from "@/common/db";
import { redis } from "@/common/redis";
import { bn, fromBuffer, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { getNetworkSettings } from "@/config/network";
import { fetchTransaction } from "@/events-sync/utils";
import { Sources } from "@/models/sources";
import { CollectionMint, simulateAndSaveCollectionMint } from "@/utils/mints/collection-mints";
import { getMethodSignature } from "@/utils/mints/method-signatures";

export const detectMint = async (txHash: string, skipCache = false) => {
  // Fetch all transfers associated to the transaction
  const transfers = await idb
    .manyOrNone(
      `
        SELECT
          nft_transfer_events.address,
          nft_transfer_events.token_id,
          nft_transfer_events.amount,
          nft_transfer_events.from,
          nft_transfer_events.to
        FROM nft_transfer_events
        WHERE nft_transfer_events.tx_hash = $/txHash/
      `,
      {
        txHash: toBuffer(txHash),
      }
    )
    .then((ts) =>
      ts.map((t) => ({
        contract: fromBuffer(t.address),
        tokenId: t.token_id,
        amount: t.amount,
        from: fromBuffer(t.from),
        to: fromBuffer(t.to),
      }))
    );

  // Return early if no transfers are available
  if (!transfers.length) {
    return;
  }

  // Exclude certain contracts
  const contract = transfers[0].contract;
  if (getNetworkSettings().mintsAsSalesBlacklist.includes(contract)) {
    return;
  }

  // Make sure every mint in the transaction is associated to the same contract
  if (!transfers.every((t) => t.contract === contract)) {
    return;
  }

  // Make sure that every mint in the transaction is associated to the same collection
  const collectionsResult = await idb.manyOrNone(
    `
      SELECT
        tokens.collection_id
      FROM tokens
      WHERE tokens.contract = $/contract/
        AND tokens.token_id IN ($/tokenIds:list/)
    `,
    {
      contract: toBuffer(contract),
      tokenIds: transfers.map((t) => t.tokenId),
    }
  );
  if (!collectionsResult.length) {
    return;
  }
  const collection = collectionsResult[0].collection_id;
  if (!collectionsResult.every((c) => c.collection_id && c.collection_id === collection)) {
    return;
  }

  // For performance reasons, do at most one attempt per collection per 5 minutes
  if (!skipCache) {
    const mintDetailsLockKey = `mint-details:${collection}`;
    const mintDetailsLock = await redis.get(mintDetailsLockKey);
    if (mintDetailsLock) {
      return;
    }
    await redis.set(mintDetailsLockKey, "locked", "EX", 5 * 60);
  }

  // Return early if we already have the mint details for the collection
  const collectionMintResult = await idb.oneOrNone(
    "SELECT 1 FROM collection_mints WHERE collection_id = $/collection/",
    { collection }
  );
  if (collectionMintResult) {
    return;
  }

  // Make sure every mint in the transaction goes to the transaction sender
  const tx = await fetchTransaction(txHash);
  if (!transfers.every((t) => t.from === AddressZero && t.to === tx.from)) {
    return;
  }

  // Make sure something was actually minted
  const amountMinted = transfers.map((t) => Number(t.amount)).reduce((a, b) => a + b);
  if (amountMinted === 0) {
    return;
  }

  // Make sure the total price is evenly divisible by the amount
  const pricePerAmountMinted = bn(tx.value).div(amountMinted);
  if (!bn(tx.value).eq(pricePerAmountMinted.mul(amountMinted))) {
    return;
  }

  // Allow at most a few decimals for the unit price
  const splittedPrice = formatEther(pricePerAmountMinted).split(".");
  if (splittedPrice.length > 1) {
    const numDecimals = splittedPrice[1].length;
    if (numDecimals > 7) {
      return;
    }
  }

  // There must be some calldata
  if (tx.data.length < 10) {
    return;
  }

  // Remove any source tags at the end of the calldata (`mint.fun` uses them)
  if (tx.data.length > 10) {
    const sources = await Sources.getInstance();
    const source = sources.getByDomainHash(tx.data.slice(-8));
    if (source) {
      tx.data = tx.data.slice(0, -8);
    }
  }

  let collectionMint: CollectionMint | undefined;

  if (tx.data.length === 10) {
    // Case 1: empty
    collectionMint = {
      collection,
      stage: "public-sale",
      kind: "public",
      status: "open",
      standardAndDetails: {
        standard: "unknown",
        details: {
          kind: "empty",
          methodSignature: tx.data,
          methodParams: "",
        },
      },
      currency: Sdk.Common.Addresses.Eth[config.chainId],
      price: pricePerAmountMinted.toString(),
    };
  }

  // Try to get the method signature from the calldata
  const methodSignature = await getMethodSignature(tx.data);
  if (!methodSignature) {
    return;
  }

  // For now, we only support simple data types in the calldata
  if (["(", ")", "[", "]", "bytes", "string"].some((x) => methodSignature.params.includes(x))) {
    return;
  }

  const params = methodSignature.params.split(",");
  if (params.length === 1 && params[0].includes("int")) {
    // Case 2: numeric
    const numericValue = bn(methodSignature.decodedCalldata[0]);
    if (numericValue.eq(amountMinted)) {
      collectionMint = {
        collection,
        stage: "public-sale",
        kind: "public",
        status: "open",
        standardAndDetails: {
          standard: "unknown",
          details: {
            kind: "numeric",
            methodSignature: methodSignature.signature,
            methodParams: methodSignature.params,
          },
        },
        currency: Sdk.Common.Addresses.Eth[config.chainId],
        price: pricePerAmountMinted.toString(),
      };
    }
  } else if (params.length === 1 && params[0] === "address") {
    // Case 3: address
    const addressValue = methodSignature.decodedCalldata[0].toLowerCase();
    if ([AddressZero, tx.from, contract].includes(addressValue)) {
      collectionMint = {
        collection,
        stage: "public-sale",
        kind: "public",
        status: "open",
        standardAndDetails: {
          standard: "unknown",
          details: {
            kind: "address",
            methodSignature: methodSignature.signature,
            methodParams: methodSignature.params,
          },
        },
        currency: Sdk.Common.Addresses.Eth[config.chainId],
        price: pricePerAmountMinted.toString(),
      };
    }
  } else if (params.length === 2 && params[0] === "address" && params[1].includes("int")) {
    // Case 4: address-numeric
    const addressValue = methodSignature.decodedCalldata[0].toLowerCase();
    const numericValue = bn(methodSignature.decodedCalldata[1]);
    if ([AddressZero, tx.from].includes(addressValue) && numericValue.eq(amountMinted)) {
      collectionMint = {
        collection,
        stage: "public-sale",
        kind: "public",
        status: "open",
        standardAndDetails: {
          standard: "unknown",
          details: {
            kind: "address-numeric",
            methodSignature: methodSignature.signature,
            methodParams: methodSignature.params,
          },
        },
        currency: Sdk.Common.Addresses.Eth[config.chainId],
        price: pricePerAmountMinted.toString(),
      };
    }
  } else if (params.length === 2 && params[0].includes("int") && params[1] === "address") {
    // Case 5: numeric-address
    const numericValue = bn(methodSignature.decodedCalldata[0]);
    const addressValue = methodSignature.decodedCalldata[1].toLowerCase();
    if ([AddressZero, tx.from].includes(addressValue) && numericValue.eq(amountMinted)) {
      collectionMint = {
        collection,
        stage: "public-sale",
        kind: "public",
        status: "open",
        standardAndDetails: {
          standard: "unknown",
          details: {
            kind: "numeric-address",
            methodSignature: methodSignature.signature,
            methodParams: methodSignature.params,
          },
        },
        currency: Sdk.Common.Addresses.Eth[config.chainId],
        price: pricePerAmountMinted.toString(),
      };
    }
  }

  if (collectionMint) {
    return simulateAndSaveCollectionMint(collectionMint);
  } else {
    return false;
  }
};