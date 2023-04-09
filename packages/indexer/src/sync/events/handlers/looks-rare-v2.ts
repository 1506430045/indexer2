import { Log } from "@ethersproject/abstract-provider";

import { bn } from "@/common/utils";
import { getEventData } from "@/events-sync/data";
import { EnhancedEvent, OnChainData } from "@/events-sync/handlers/utils";
import * as utils from "@/events-sync/utils";
import { getERC20Transfer } from "@/events-sync/handlers/utils/erc20";
import { getUSDAndNativePrices } from "@/utils/prices";

export const handleEvents = async (events: EnhancedEvent[], onChainData: OnChainData) => {
  // Keep track of all events within the currently processing transaction
  let currentTx: string | undefined;
  let currentTxLogs: Log[] = [];

  // Handle the events
  for (const { subKind, baseEventParams, log } of events) {
    if (currentTx !== baseEventParams.txHash) {
      currentTx = baseEventParams.txHash;
      currentTxLogs = [];
    }
    currentTxLogs.push(log);

    const eventData = getEventData([subKind])[0];
    switch (subKind) {
      case "looks-rare-v2-new-bid-ask-nonces": {
        const parsedLog = eventData.abi.parseLog(log);
        const maker = parsedLog.args["user"].toLowerCase();
        const bidNonce = parsedLog.args["bidNonce"].toString();
        const askNonce = parsedLog.args["askNonce"].toString();

        let batchIndex = baseEventParams.batchIndex;
        onChainData.bulkCancelEvents.push({
          orderKind: "looks-rare-v2",
          maker,
          minNonce: askNonce,
          baseEventParams: {
            ...baseEventParams,
            batchIndex: batchIndex++,
          },
          orderSide: "sell",
          acrossAll: true,
        });

        onChainData.bulkCancelEvents.push({
          orderKind: "looks-rare-v2",
          maker,
          minNonce: bidNonce,
          orderSide: "buy",
          acrossAll: true,
          baseEventParams: {
            ...baseEventParams,
            batchIndex: batchIndex++,
          },
        });

        break;
      }

      case "looks-rare-v2-subset-nonces-cancelled": {
        const parsedLog = eventData.abi.parseLog(log);
        const maker = parsedLog.args["user"].toLowerCase();
        const subsetNonces = parsedLog.args["subsetNonces"].map(String);

        let batchIndex = 1;
        for (const subsetNonce of subsetNonces) {
          onChainData.nonceCancelEvents.push({
            orderKind: "looks-rare-v2",
            maker,
            nonce: subsetNonce,
            baseEventParams: {
              ...baseEventParams,
              batchIndex: batchIndex++,
            },
            isSubset: true,
          });
        }

        break;
      }

      case "looks-rare-v2-order-nonces-cancelled": {
        const parsedLog = eventData.abi.parseLog(log);
        const maker = parsedLog.args["user"].toLowerCase();
        const orderNonces = parsedLog.args["orderNonces"].map(String);

        let batchIndex = 1;
        for (const orderNonce of orderNonces) {
          onChainData.nonceCancelEvents.push({
            orderKind: "looks-rare-v2",
            maker,
            nonce: orderNonce,
            baseEventParams: {
              ...baseEventParams,
              batchIndex: batchIndex++,
            },
          });
        }

        break;
      }

      case "looks-rare-v2-taker-ask": {
        const parsedLog = eventData.abi.parseLog(log);

        const orderId = parsedLog.args["nonceInvalidationParameters"]["orderHash"].toLowerCase();
        const orderNonce = parsedLog.args["nonceInvalidationParameters"]["orderNonce"].toString();

        const maker = parsedLog.args["bidUser"].toLowerCase();
        let taker = parsedLog.args["askUser"].toLowerCase();

        const currency = parsedLog.args["currency"].toLowerCase();
        // let currencyPrice = parsedLog.args["price"].toString();
        const contract = parsedLog.args["collection"].toLowerCase();

        // It's might be multiple
        if (parsedLog.args["itemIds"].length > 1) {
          // Skip bundle order
          break;
        }

        const tokenId = parsedLog.args["itemIds"][0].toString();
        const amount = parsedLog.args["amounts"][0].toString();

        let currencyPrice = parsedLog.args["feeAmounts"][0].toString();

        // Handle: attribution

        const orderKind = "looks-rare-v2";
        const attributionData = await utils.extractAttributionData(
          baseEventParams.txHash,
          orderKind,
          { orderId }
        );
        if (attributionData.taker) {
          taker = attributionData.taker;
        }

        // Handle: prices

        currencyPrice = bn(currencyPrice).div(amount).toString();
        const priceData = await getUSDAndNativePrices(
          currency,
          currencyPrice,
          baseEventParams.timestamp
        );
        if (!priceData.nativePrice) {
          // We must always have the native price
          break;
        }

        onChainData.fillEvents.push({
          orderKind,
          orderId,
          orderSide: "buy",
          maker,
          taker,
          price: priceData.nativePrice,
          currency,
          currencyPrice,
          usdPrice: priceData.usdPrice,
          contract,
          tokenId,
          amount,
          orderSourceId: attributionData.orderSource?.id,
          aggregatorSourceId: attributionData.aggregatorSource?.id,
          fillSourceId: attributionData.fillSource?.id,
          baseEventParams,
        });

        // Cancel all the other orders of the maker having the same nonce
        onChainData.nonceCancelEvents.push({
          orderKind: "looks-rare-v2",
          maker,
          nonce: orderNonce,
          baseEventParams,
        });

        onChainData.orderInfos.push({
          context: `filled-${orderId}`,
          id: orderId,
          trigger: {
            kind: "sale",
            txHash: baseEventParams.txHash,
            txTimestamp: baseEventParams.timestamp,
          },
        });

        onChainData.fillInfos.push({
          context: orderId,
          orderId: orderId,
          orderSide: "buy",
          contract,
          tokenId,
          amount,
          price: priceData.nativePrice,
          timestamp: baseEventParams.timestamp,
          maker,
          taker,
        });

        // If an ERC20 transfer occured in the same transaction as a sale
        // then we need resync the maker's ERC20 approval to the exchange
        const erc20 = getERC20Transfer(currentTxLogs);
        if (erc20) {
          onChainData.makerInfos.push({
            context: `${baseEventParams.txHash}-buy-approval`,
            maker,
            trigger: {
              kind: "approval-change",
              txHash: baseEventParams.txHash,
              txTimestamp: baseEventParams.timestamp,
            },
            data: {
              kind: "buy-approval",
              contract: erc20,
              orderKind: "looks-rare-v2",
            },
          });
        }

        break;
      }

      case "looks-rare-v2-taker-bid": {
        const parsedLog = eventData.abi.parseLog(log);
        const orderId = parsedLog.args["nonceInvalidationParameters"]["orderHash"].toLowerCase();
        const orderNonce = parsedLog.args["nonceInvalidationParameters"]["orderNonce"].toString();
        const maker = parsedLog.args["bidUser"].toLowerCase();
        let taker = parsedLog.args["bidRecipient"].toLowerCase();
        const currency = parsedLog.args["currency"].toLowerCase();
        let currencyPrice = parsedLog.args["feeAmounts"][0].toString();
        const contract = parsedLog.args["collection"].toLowerCase();

        // It's might be multiple
        if (parsedLog.args["itemIds"].length > 1) {
          // Skip bundle order
          break;
        }

        const tokenId = parsedLog.args["itemIds"][0].toString();
        const amount = parsedLog.args["amounts"][0].toString();

        // Handle: attribution

        const orderKind = "looks-rare-v2";
        const attributionData = await utils.extractAttributionData(
          baseEventParams.txHash,
          orderKind,
          { orderId }
        );
        if (attributionData.taker) {
          taker = attributionData.taker;
        }

        // Handle: prices

        currencyPrice = bn(currencyPrice).div(amount).toString();
        const priceData = await getUSDAndNativePrices(
          currency,
          currencyPrice,
          baseEventParams.timestamp
        );
        if (!priceData.nativePrice) {
          // We must always have the native price
          break;
        }

        onChainData.fillEvents.push({
          orderKind,
          orderId,
          orderSide: "sell",
          maker,
          taker,
          price: priceData.nativePrice,
          currency,
          currencyPrice,
          usdPrice: priceData.usdPrice,
          contract,
          tokenId,
          amount,
          orderSourceId: attributionData.orderSource?.id,
          aggregatorSourceId: attributionData.aggregatorSource?.id,
          fillSourceId: attributionData.fillSource?.id,
          baseEventParams,
        });

        // Cancel all the other orders of the maker having the same nonce
        onChainData.nonceCancelEvents.push({
          orderKind: "looks-rare-v2",
          maker,
          nonce: orderNonce,
          baseEventParams,
        });

        onChainData.orderInfos.push({
          context: `filled-${orderId}`,
          id: orderId,
          trigger: {
            kind: "sale",
            txHash: baseEventParams.txHash,
            txTimestamp: baseEventParams.timestamp,
          },
        });

        onChainData.fillInfos.push({
          context: orderId,
          orderId: orderId,
          orderSide: "sell",
          contract,
          tokenId,
          amount,
          price: priceData.nativePrice,
          timestamp: baseEventParams.timestamp,
          maker,
          taker,
        });

        break;
      }
    }
  }
};
