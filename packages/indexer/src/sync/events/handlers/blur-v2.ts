import { searchForCall } from "@georgeroman/evm-tx-simulator";
import * as Sdk from "@reservoir0x/sdk";

import { logger } from "@/common/logger";
import { config } from "@/config/index";
import { getEventData } from "@/events-sync/data";
import { EnhancedEvent, OnChainData } from "@/events-sync/handlers/utils";
import * as utils from "@/events-sync/utils";
import { getUSDAndNativePrices } from "@/utils/prices";

export const handleEvents = async (events: EnhancedEvent[], onChainData: OnChainData) => {
  // For keeping track of all individual trades per transaction
  const trades = {
    order: new Map<string, number>(),
  };

  // Handle the events
  for (const { subKind, baseEventParams } of events) {
    switch (subKind) {
      case "blur-v2-execution":
      case "blur-v2-execution-721-packed":
      case "blur-v2-execution-721-taker-fee-packed":
      case "blur-v2-execution-721-maker-fee-packed": {
        const txHash = baseEventParams.txHash;
        const txTrace = await utils.fetchTransactionTrace(txHash);
        if (!txTrace) {
          // Skip any failed attempts to get the trace
          break;
        }

        const exchange = new Sdk.BlurV2.Exchange(config.chainId);
        const exchangeAddress = Sdk.BlurV2.Addresses.Exchange[config.chainId];
        const methods = [
          {
            selector: "0x3925c3c3",
            name: "takeAsk",
          },
          {
            selector: "0x70bce2d6",
            name: "takeAskSingle",
          },
          {
            selector: "0x133ba9a6",
            name: "takeAskPool",
          },
          {
            selector: "0x336d8206",
            name: "takeAskSinglePool",
          },
          {
            selector: "0x7034d120",
            name: "takeBid",
          },
          {
            selector: "0xda815cb5",
            name: "takeBidSingle",
          },
        ];

        const tradeRank = trades.order.get(`${txHash}-${exchangeAddress}`) ?? 0;
        const executeCallTrace = searchForCall(
          txTrace.calls,
          {
            to: exchangeAddress,
            type: "CALL",
            sigHashes: methods.map((c) => c.selector),
          },
          tradeRank
        );
        if (!executeCallTrace) {
          break;
        }

        const matchMethod = methods.find((c) => executeCallTrace.input.includes(c.selector));
        if (!matchMethod) {
          break;
        }

        const inputData = exchange.contract.interface.decodeFunctionData(
          matchMethod.name,
          executeCallTrace.input
        );

        const isTakeAsk = ["takeAsk", "takeAskSingle", "takeAskPool", "takeAskSinglePool"].includes(
          matchMethod.name
        );
        const isBatchCall = ["takeAsk", "takeAskPool", "takeBid"].includes(matchMethod.name);

        const rawInput = inputData.inputs;
        const inputs = !isBatchCall
          ? [inputData.inputs]
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            inputData.inputs.exchanges.map((exchange: any) => {
              return {
                order: inputData.inputs.orders[exchange.index],
                exchange,
              };
            });

        for (let i = 0; i < inputs.length; i++) {
          const { order, exchange } = inputs[i];

          logger.info("blur-debug-events", JSON.stringify({ events, inputs }));
          const relevantEvent = events.filter((e) => e.subKind.startsWith("blur-v2-execution"))[
            onChainData.fillEventsPartial.length
          ];
          const eventData = getEventData([relevantEvent.subKind])[0];
          const { args } = eventData.abi.parseLog(relevantEvent.log);
          const orderId = args.orderHash.toLowerCase();

          const listing = exchange.listing;
          const takerData = exchange.taker;

          const tokenRecipient = isTakeAsk
            ? rawInput.tokenRecipient.toLowerCase()
            : (await utils.fetchTransaction(baseEventParams.txHash)).from.toLowerCase();

          const trader = order.trader.toLowerCase();
          const collection = order.collection.toLowerCase();
          const tokenId = takerData.tokenId.toString();
          const amount = takerData.amount.toString();

          const maker = trader;
          let taker = tokenRecipient;
          const currencyPrice = listing.price.toString();
          const orderSide = isTakeAsk ? "sell" : "buy";

          // Handle: attribution
          const orderKind = "blur-v2";
          const attributionData = await utils.extractAttributionData(
            baseEventParams.txHash,
            orderKind
          );
          if (attributionData.taker) {
            taker = attributionData.taker;
          }

          // Handle: prices
          const currency = Sdk.Common.Addresses.Eth[config.chainId];
          const priceData = await getUSDAndNativePrices(
            currency,
            currencyPrice,
            baseEventParams.timestamp
          );
          if (!priceData.nativePrice) {
            // We must always have the native price
            break;
          }

          onChainData.fillEventsPartial.push({
            orderId,
            orderKind,
            orderSide,
            maker,
            taker,
            price: priceData.nativePrice,
            currency,
            currencyPrice,
            usdPrice: priceData.usdPrice,
            contract: collection.toLowerCase(),
            tokenId: tokenId.toString(),
            amount: amount.toString(),
            orderSourceId: attributionData.orderSource?.id,
            aggregatorSourceId: attributionData.aggregatorSource?.id,
            fillSourceId: attributionData.fillSource?.id,
            baseEventParams: {
              ...baseEventParams,
              logIndex: baseEventParams.logIndex + i,
            },
          });
        }

        trades.order.set(`${txHash}-${exchangeAddress}`, tradeRank + 1);

        break;
      }
    }
  }
};
