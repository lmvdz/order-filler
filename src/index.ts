import { BN, Provider } from '@project-serum/anchor';
import * as BufferLayout from '@solana/buffer-layout';
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction } from '@solana/web3.js';
import { u64 } from "@solana/spl-token";

import {
	BulkAccountLoader,
	ClearingHouse,
	initialize,
	ClearingHouseUser,
	isVariant,
	Markets,
	UserOrdersAccount,
	OrderRecord,
	getUserOrdersAccountPublicKey,
	calculateMarkPrice,
	convertToNumber,
	MARK_PRICE_PRECISION,
	TEN_THOUSAND,
	isOrderRiskIncreasing,
	Wallet,
	getClearingHouse,
	getPollingClearingHouseConfig,
	getClearingHouseUser,
	getPollingClearingHouseUserConfig,
	calculateOrderFeeTier,
	calculateFeeForLimitOrder,
	calculateAmmReservesAfterSwap,
	SwapDirection,
	calculateNewMarketAfterTrade,
	PEG_PRECISION,
	AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	BASE_PRECISION
} from '@drift-labs/sdk';

import { Node, OrderList, sortDirectionForOrder } from './OrderList';
import { CloudWatchClient } from './cloudWatchClient';
import { bulkPollingUserSubscribe } from '@drift-labs/sdk/lib/accounts/bulkUserSubscription';
import * as bs58 from 'bs58';

require('dotenv').config();



//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });

const cloudWatchClient = new CloudWatchClient(
	sdkConfig.ENV === 'mainnet-beta' ? 'eu-west-1' : 'us-east-1',
	process.env.ENABLE_CLOUDWATCH === 'true'
);



function getWallet(): Wallet {
	const botKeyEnvVariable = "BOT_KEY";
	// ENVIRONMENT VARIABLE FOR THE BOT PRIVATE KEY
	const botKey = process.env[botKeyEnvVariable];

	if (botKey === undefined) {
		console.error('need a ' + botKeyEnvVariable +' env variable');
		process.exit();
	}
	// setup wallet
	let keypair;

	try {
		keypair = Keypair.fromSecretKey(
			bs58.decode(botKey, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
		);
	} catch {
		try {
			keypair = Keypair.fromSecretKey(
				Uint8Array.from(JSON.parse(botKey))
			);
		} catch {
			console.error('Failed to parse private key from Uint8Array (solana-keygen) and base58 encoded string (phantom wallet export)');
			process.exit();
		}
	}
	return new Wallet(keypair);
}

const endpoint = process.env.ENDPOINT;
const connection = new Connection(endpoint);

const intervalIds = [];
const runBot = async (wallet: Wallet, clearingHouse: ClearingHouse) => {
	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	console.log('SOL balance:', lamportsBalance / 10 ** 9);
	await clearingHouse.subscribe(['orderHistoryAccount']);
	console.log(clearingHouse.program.programId.toString());

	const marketOrderLists = new Map<
		number,
		{ desc: OrderList; asc: OrderList }
	>();
	for (const market of Markets) {
		const longs = new OrderList(market.marketIndex, 'desc');
		const shorts = new OrderList(market.marketIndex, 'asc');

		marketOrderLists.set(market.marketIndex.toNumber(), {
			desc: longs,
			asc: shorts,
		});
	}

	// explicitly grab order index before we initially build order list
	// so we're less likely to have missed records while we fetch order accounts
	let nextOrderHistoryIndex = clearingHouse
		.getOrderHistoryAccount()
		.head.toNumber();

	const programAccounts = await clearingHouse.program.account.userOrders.all();
	for (const programAccount of programAccounts) {
		const userOrderAccountPublicKey = programAccount.publicKey;
		// @ts-ignore
		const userOrdersAccount: UserOrdersAccount = programAccount.account;
		const userAccountPublicKey = userOrdersAccount.user;

		userOrdersAccount.orders.forEach(async order => {
			if (!isVariant(order, 'init') && !isVariant(order.orderType, 'market')) {
				marketOrderLists.get(order.marketIndex.toNumber())[sortDirectionForOrder(order)].insert(order, userAccountPublicKey, userOrderAccountPublicKey);
			}
		});
	}

	const printTopOfOrdersList = (ascList: OrderList, descList: OrderList) => {
		console.log(`Market ${Markets[descList.marketIndex.toNumber()].symbol}`);
		descList.printTop();
		console.log(
			`Mark`,
			convertToNumber(
				calculateMarkPrice(clearingHouse.getMarket(descList.marketIndex)),
				MARK_PRICE_PRECISION
			).toFixed(3)
		);
		ascList.printTop();
	};

	for (const [_, ordersList] of marketOrderLists) {
		printTopOfOrdersList(ordersList.asc, ordersList.desc);
	}

	const sleep = (ms: number) => {
		return new Promise((resolve) => {
			setTimeout(resolve, ms);
		});
	};

	const updateUserOrders = (user: ClearingHouseUser): BN => {
		const marginRatio = user.getMarginRatio();

		const userOrdersAccount = user.getUserOrdersAccount();

		if (userOrdersAccount) {
			const tooMuchLeverage = marginRatio.lte(
				user.clearingHouse.getStateAccount().marginRatioInitial
			);

			userOrdersAccount.orders.forEach(async order => {
				const orderList = marketOrderLists.get(order.marketIndex.toNumber())[sortDirectionForOrder(order)];
				const orderIsRiskIncreasing = isOrderRiskIncreasing(user, order);

				if (tooMuchLeverage && orderIsRiskIncreasing) {
					orderList.updateUserCanTake(order.orderId.toNumber(), false);
				} else if (orderIsRiskIncreasing && order.reduceOnly) {
					orderList.updateUserCanTake(order.orderId.toNumber(), false);
				} else {
					orderList.updateUserCanTake(order.orderId.toNumber(), true);
				}
			});
		}
		return marginRatio;
	};
	const processUser = async (user: ClearingHouseUser) => {
		const userAccountPublicKey = await user.getUserAccountPublicKey();

		user.eventEmitter.on('userPositionsData', () => {
			updateUserOrders(user);
			userMap.set(userAccountPublicKey.toString(), { user, upToDate: true });
		});

		// eslint-disable-next-line no-constant-condition
		while (true) {
			const marginRatio = updateUserOrders(user);
			const marginRatioNumber = convertToNumber(marginRatio, TEN_THOUSAND);
			const oneMinute = 1000 * 60;
			const sleepTime = Math.min(
				Math.round(marginRatioNumber * 100) ** 2,
				oneMinute
			);
			await sleep(sleepTime);
		}
	};

	const userAccountLoader = new BulkAccountLoader(
		connection,
		'processed',
		5000
	);
	const userMap = new Map<
		string,
		{ user: ClearingHouseUser; upToDate: boolean }
	>();
	const fetchAllUsers = async () => {
		const programUserAccounts = await clearingHouse.program.account.user.all();
		const userArray: ClearingHouseUser[] = [];
		for (const programUserAccount of programUserAccounts) {
			const userAccountPubkey = programUserAccount.publicKey.toString();
			if (userMap.has(userAccountPubkey)) {
				continue;
			}
			const user = getClearingHouseUser(
				getPollingClearingHouseUserConfig(
					clearingHouse,
					programUserAccount.account.authority,
					userAccountLoader
				)
			);
			userArray.push(user);
		}

		await bulkPollingUserSubscribe(userArray, userAccountLoader);
		for (const user of userArray) {
			const userAccountPubkey = await user.getUserAccountPublicKey();
			userMap.set(userAccountPubkey.toString(), { user, upToDate: true });
			processUser(user);
		}
	};
	await fetchAllUsers();

	let updateOrderListMutex = 0;
	const handleOrderRecord = async (record: OrderRecord) => {
		const order = record.order;
		// Disregard market orders
		if (isVariant(order.orderType, 'market')) {
			return;
		}

		const ordersList = marketOrderLists.get(order.marketIndex.toNumber());
		const orderList = ordersList[sortDirectionForOrder(order)];

		if (isVariant(record.action, 'place')) {
			const userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
				clearingHouse.program.programId,
				record.user
			);
			orderList.insert(order, record.user, userOrdersAccountPublicKey);
			console.log(`Order ${order.orderId.toString()} placed. Added to order list`);
		} else if (isVariant(record.action, 'cancel')) {
			orderList.remove(order.orderId.toNumber());
			console.log(`Order ${order.orderId.toString()} canceled. Removed from order list`);
		} else if (isVariant(record.action, 'fill')) {
			if (order.baseAssetAmount.eq(order.baseAssetAmountFilled)) {
				orderList.remove(order.orderId.toNumber());
				console.log(`Order ${order.orderId.toString()} completely filled. Removed from order list`);
			} else {
				orderList.update(order);
				console.log(`Order ${order.orderId.toString()} partially filled. Updated`);
			}
		}
		printTopOfOrdersList(ordersList.asc, ordersList.desc);
	};

	const updateOrderList = async () => {
		if (updateOrderListMutex === 1) {
			return;
		}
		updateOrderListMutex = 1;

		let head = clearingHouse.getOrderHistoryAccount().head.toNumber();
		while (nextOrderHistoryIndex !== head) {
			const nextRecord =
				clearingHouse.getOrderHistoryAccount().orderRecords[
					nextOrderHistoryIndex
				];
			await handleOrderRecord(nextRecord);
			nextOrderHistoryIndex += 1;
			head = clearingHouse.getOrderHistoryAccount().head.toNumber();
		}
		updateOrderListMutex = 0;
	};

	clearingHouse.eventEmitter.on('orderHistoryAccountUpdate', updateOrderList);
	await updateOrderList();

	const findNodeToFill = async (
		node: Node,
		markPrice: BN
	): Promise<Node | undefined> => {
		let currentNode = node;
		while (currentNode !== undefined) {
			if (!currentNode.pricesCross(markPrice)) {
				currentNode = undefined;
				break;
			}

			let mapValue = userMap.get(node.userAccount.toString());
			if (!mapValue) {
				const userAccount = await clearingHouse.program.account.user.fetch(
					node.userAccount
				);
				const user = getClearingHouseUser(
					getPollingClearingHouseUserConfig(
						clearingHouse,
						userAccount.authority,
						userAccountLoader
					)
				);
				await user.subscribe();
				mapValue = { user, upToDate: true };
				userMap.set(node.userAccount.toString(), mapValue);
				processUser(user);
			}
			const { upToDate: userUpToDate } = mapValue;

			if (!currentNode.haveFilled && userUpToDate && currentNode.userCanTake) {
				break;
			}

			currentNode = currentNode.next;
		}

		return currentNode;
	};

	const perMarketMutex = Array(64).fill(0);
	const tryFillForMarket = async (marketIndex: BN) => {
		if (perMarketMutex[marketIndex.toNumber()] === 1) {
			return;
		}
		perMarketMutex[marketIndex.toNumber()] = 1;

		const market = clearingHouse.getMarket(marketIndex);
		const orderLists = marketOrderLists.get(marketIndex.toNumber());
		const markPrice = calculateMarkPrice(market);

		let nodeToFill: Node | undefined = undefined;
		if (orderLists.asc.head && orderLists.asc.head.pricesCross(markPrice)) {
			nodeToFill = await findNodeToFill(orderLists.asc.head, markPrice);
		} else if (
			orderLists.desc.head &&
			orderLists.desc.head.pricesCross(markPrice)
		) {
			nodeToFill = await findNodeToFill(orderLists.desc.head, markPrice);
		}

		if (nodeToFill !== undefined && !nodeToFill.haveFilled) {
			const { user } = userMap.get(nodeToFill.userAccount.toString());
			userMap.set(nodeToFill.userAccount.toString(), { user, upToDate: false });
			nodeToFill.haveFilled = true;

			console.log(
				`trying to fill (account: ${nodeToFill.userAccount.toString()})`
			);
			const frontRun = new Transaction();
			
			const clock = await getClock(connection);

			const [fillOrderNewQuoteAssetReserve,] =  calculateAmmReservesAfterSwap(market.amm, 'base', (nodeToFill.order.baseAssetAmount.sub(nodeToFill.order.baseAssetAmountFilled)), SwapDirection.REMOVE);
			const maxPossibleFillOrderQuoteAmount = (fillOrderNewQuoteAssetReserve.sub(market.amm.quoteAssetReserve)).mul(PEG_PRECISION).div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);
			const maxLimitOrderFee = calculateFeeForLimitOrder(maxPossibleFillOrderQuoteAmount, clearingHouse.getStateAccount().feeStructure, clearingHouse.getOrderStateAccount().orderFillerRewardStructure, calculateOrderFeeTier(clearingHouse.getStateAccount().feeStructure), nodeToFill.order.ts, clock.unixTimestamp);
			
			const [, fillerRewardNewBaseAssetReserve] =  calculateAmmReservesAfterSwap(market.amm, 'quote', maxLimitOrderFee.fillerReward, SwapDirection.ADD);
			

			const newMarket = calculateNewMarketAfterTrade((nodeToFill.order.baseAssetAmount.sub(nodeToFill.order.baseAssetAmountFilled).add((fillerRewardNewBaseAssetReserve.mul(PEG_PRECISION).div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)))), nodeToFill.order.direction, market);

			const marketPrice = convertToNumber(markPrice, MARK_PRICE_PRECISION);
			const marketPriceAfter = convertToNumber(calculateMarkPrice(newMarket), MARK_PRICE_PRECISION);
			const spread = Math.abs(marketPrice - marketPriceAfter);
			const maxFillerReward = convertToNumber(maxLimitOrderFee.fillerReward, new BN(10 ** 6));
			const maxFrontRunQuoteAmount = (maxFillerReward + (spread)) * (10 ** 6);

			// console.log(convertToNumber(limitOrderFee.fillerReward, new BN(10 ** 6)), quoteSwapAmount.div(AMM_RESERVE_PRECISION).toNumber(), nodeToFill.order.baseAssetAmount.div(AMM_RESERVE_PRECISION).toNumber(), nodeToFill.order.ts.toNumber(), clock.unixTimestamp.toNumber());
			// console.log((((nodeToFill.order.baseAssetAmount.sub(nodeToFill.order.baseAssetAmountFilled)).div(new BN(10 ** 7))).mul(new BN(convertToNumber(markPrice, MARK_PRICE_PRECISION)))).toNumber());
			// frontRun.add(await clearingHouse.getOpenPositionIx(nodeToFill.order.direction, ((nodeToFill.order.baseAssetAmount.sub(nodeToFill.order.baseAssetAmountFilled)).div(new BN(10 ** 7))).mul(new BN(convertToNumber(markPrice, MARK_PRICE_PRECISION))), nodeToFill.order.marketIndex));
			// frontRun.add(await clearingHouse.getOpenPositionIx(nodeToFill.order.direction, frontRunQuoteAmount, nodeToFill.order.marketIndex));
			console.log(convertToNumber(nodeToFill.order.baseAssetAmount.sub(nodeToFill.order.baseAssetAmountFilled), BASE_PRECISION), spread, maxFillerReward, marketPrice, marketPriceAfter, maxFrontRunQuoteAmount);
			frontRun.add(await clearingHouse.getFillOrderIx(nodeToFill.userAccount, nodeToFill.userOrdersAccount, nodeToFill.order));
			// frontRun.add(await clearingHouse.getClosePositionIx(nodeToFill.order.marketIndex));

			try {
				const txSig = await clearingHouse.txSender.send(frontRun, [], clearingHouse.opts);
				console.log(
					`Filled user (account: ${nodeToFill.userAccount.toString()}) order: ${nodeToFill.order.orderId.toString()}`
				);
				console.log(`Tx: ${txSig}`);
				cloudWatchClient.logFill(true);
			} catch (error) {
				nodeToFill.haveFilled = false;
				userMap.set(nodeToFill.userAccount.toString(), {
					user,
					upToDate: true,
				});
				console.log(
					`Error filling user (account: ${nodeToFill.userAccount.toString()}) order: ${nodeToFill.order.orderId.toString()}`
				);
				cloudWatchClient.logFill(false);
			}
		}
		perMarketMutex[marketIndex.toNumber()] = 0;
	};

	const tryFill = () => {
		Markets.forEach(async market => {
			tryFillForMarket(market.marketIndex);
		});
	};

	tryFill();
	const handleFillIntervalId = setInterval(tryFill, 1000); // every second
	intervalIds.push(handleFillIntervalId);
};

async function recursiveTryCatch(f: () => void) {
	function sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	try {
		await f();
	} catch (e) {
		console.error(e);
		for (const intervalId of intervalIds) {
			clearInterval(intervalId);
		}
		await sleep(15000);
		await recursiveTryCatch(f);
	}
}

const wallet = getWallet();
const provider = new Provider(connection, wallet, Provider.defaultOptions());
const clearingHousePublicKey = new PublicKey(
	sdkConfig.CLEARING_HOUSE_PROGRAM_ID
);

const clearingHouse = getClearingHouse(
	getPollingClearingHouseConfig(
		connection,
		provider.wallet,
		clearingHousePublicKey,
		new BulkAccountLoader(connection, 'confirmed', 500)
	)
);

const uint64 = (property = "uint64") => {
    return BufferLayout.blob(8, property);
};

function uint8ToU64(data) {
    return new u64(data, 10, "le");
}


const CLOCK_LAYOUT = BufferLayout.struct([
	uint64('slot'),
	uint64('epochStartTimestamp'),
	uint64('epoch'),
	uint64('leaderScheduleEpoch'),
	uint64('unixTimestamp')

]);

interface Clock {
	slot: u64,
	epochStartTimestamp: u64,
	epoch: u64,
	leaderScheduleEpoch: u64,
	unixTimestamp: u64
}

const getClock = ( connection: Connection ) : Promise<Clock> => {
	return new Promise((resolve) => {
		connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'processed').then(clockAccountInfo => {
			const decoded = CLOCK_LAYOUT.decode(Uint8Array.from(clockAccountInfo.data));
			resolve({
				slot: uint8ToU64(decoded.slot),
				epochStartTimestamp: uint8ToU64(decoded.epochStartTimestamp),
				epoch: uint8ToU64(decoded.epoch),
				leaderScheduleEpoch: uint8ToU64(decoded.leaderScheduleEpoch),
				unixTimestamp: uint8ToU64(decoded.unixTimestamp),
			} as Clock);
		});
	});
};

getClock(connection).then(clock => {
	console.log(clock.unixTimestamp.toNumber());
});

recursiveTryCatch(() => runBot(wallet, clearingHouse));



