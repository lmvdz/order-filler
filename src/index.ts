import { BN, ProgramAccount, Provider } from '@project-serum/anchor';
import * as BufferLayout from '@solana/buffer-layout';
import { Connection, Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction } from '@solana/web3.js';
import { u64 } from "@solana/spl-token";

import {
	BulkAccountLoader,
	ClearingHouse,
	initialize,
	isVariant,
	Markets,
	UserOrdersAccount,
	OrderRecord,
	getUserOrdersAccountPublicKey,
	calculateMarkPrice,
	convertToNumber,
	MARK_PRICE_PRECISION,
	TEN_THOUSAND,
	Wallet,
	getClearingHouse,
	getPollingClearingHouseConfig,
	// calculateOrderFeeTier,
	// calculateFeeForLimitOrder,
	// calculateAmmReservesAfterSwap,
	// SwapDirection,
	// calculateNewMarketAfterTrade,
	// PEG_PRECISION,
	// AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO,
	// BASE_PRECISION,
	// calculateAmountToTrade,
	QUOTE_PRECISION,
	DriftEnv,
	UserAccount,
	calculatePositionFundingPNL,
	PRICE_TO_QUOTE_PRECISION,
	ZERO,
	Market,
	UserPosition,
	UserPositionsAccount,
	BN_MAX,
	calculateBaseAssetValue,
	Order,
	TWO,
	PollingAccountSubscriber
} from '@drift-labs/sdk';

import { Node, OrderList, sortDirectionForOrder } from './OrderList';
import { CloudWatchClient } from './cloudWatchClient';
import * as bs58 from 'bs58';
import { getErrorCode } from './error';

require('dotenv').config();


function isOrderRiskIncreasing(
	positionsAccount: UserPositionsAccount,
	order: Order
): boolean {
	if (isVariant(order.status, 'init')) {
		return false;
	}

	const position =
	positionsAccount.positions.find((position) =>
			position.marketIndex.eq(order.marketIndex)
		) || {
			baseAssetAmount: ZERO,
			lastCumulativeFundingRate: ZERO,
			marketIndex: order.marketIndex,
			quoteAssetAmount: ZERO,
			openOrders: ZERO,
		};

	// if no position exists, it's risk increasing
	if (position.baseAssetAmount.eq(ZERO)) {
		return true;
	}

	// if position is long and order is long
	if (position.baseAssetAmount.gt(ZERO) && isVariant(order.direction, 'long')) {
		return true;
	}

	// if position is short and order is short
	if (
		position.baseAssetAmount.lt(ZERO) &&
		isVariant(order.direction, 'short')
	) {
		return true;
	}

	const baseAssetAmountToFill = order.baseAssetAmount.sub(
		order.baseAssetAmountFilled
	);
	// if order will flip position
	if (baseAssetAmountToFill.gt(position.baseAssetAmount.abs().mul(TWO))) {
		return true;
	}

	return false;
}

const calculatePositionPNL = (
	market: Market,
	marketPosition: UserPosition,
    baseAssetValue: BN,
	withFunding = false
): BN  => {
	if (marketPosition.baseAssetAmount.eq(ZERO)) {
		return ZERO;
	}

	let pnlAssetAmount = (marketPosition.baseAssetAmount.gt(ZERO) ? baseAssetValue.sub(marketPosition.quoteAssetAmount) : marketPosition.quoteAssetAmount.sub(baseAssetValue));

	if (withFunding) {
		pnlAssetAmount = pnlAssetAmount.add(calculatePositionFundingPNL(
			market,
			marketPosition
		).div(PRICE_TO_QUOTE_PRECISION));
	}

	return pnlAssetAmount;
};

const getMarginRatio = (clearingHouse : ClearingHouse, user: User) => {
    const positions = user.positionsAccount.positions;
    

    if (positions.length === 0) {
        return BN_MAX;
    }

    let totalPositionValue = ZERO, unrealizedPNL = ZERO;

    positions.forEach(position => {
        const market = clearingHouse.getMarket(position.marketIndex);
        if (market !== undefined) {
            const baseAssetAmountValue = calculateBaseAssetValue(market, position);
            totalPositionValue = totalPositionValue.add(baseAssetAmountValue);
            unrealizedPNL = unrealizedPNL.add(calculatePositionPNL(market, position, baseAssetAmountValue, true));
        } else {
            console.log(user.userAccount.positions.toBase58(), user.publicKey);
            console.log(market, position.marketIndex.toString());
            console.log('market undefined', market);
        }
        
    });

    // unrealizedPnLMap.set(user.publicKey, unrealizedPNL.toString());

    if (totalPositionValue.eq(ZERO)) {
        return BN_MAX;
    }

    return (
        user.userAccount.collateral.add(unrealizedPNL) ??
        ZERO
    ).mul(TEN_THOUSAND).div(totalPositionValue);
};


//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV as DriftEnv });

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

interface User {
	marginRatio: BN,
	publicKey: string,
	positions: string,
	orders: string,
	userAccount: UserAccount
	positionsAccount: UserPositionsAccount
	ordersAccount: UserOrdersAccount,
	upToDate: boolean
}


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
	const openOrders = new Set<number>();

	// explicitly grab order index before we initially build order list
	// so we're less likely to have missed records while we fetch order accounts
	let nextOrderHistoryIndex = clearingHouse
		.getOrderHistoryAccount()
		.head.toNumber();

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

	const printOrderLists = () => {
		for (const [_, ordersList] of marketOrderLists) {
			printTopOfOrdersList(ordersList.asc, ordersList.desc);
		}
	};
	

	const updateUserOrders = (
		user: User,
		userAccountPublicKey: PublicKey,
		userOrdersAccountPublicKey: PublicKey
	): BN => {
		const marginRatio = getMarginRatio(clearingHouse, user);

		const userOrdersAccount = user.ordersAccount;

		if (userOrdersAccount) {
			const tooMuchLeverage = marginRatio.lte(
				clearingHouse.getStateAccount().marginRatioInitial
			);

			userOrdersAccount.orders.forEach(async order => {
				const ordersLists = marketOrderLists.get(order.marketIndex.toNumber());
				const orderList = ordersLists[sortDirectionForOrder(order)];
				const orderIsRiskIncreasing = isOrderRiskIncreasing(user.positionsAccount, order);

				const orderId = order.orderId.toNumber();
				if (tooMuchLeverage && orderIsRiskIncreasing) {
					if (openOrders.has(orderId) && orderList.has(orderId)) {
						console.log(
							`User has too much leverage and order is risk increasing. Removing order ${order.orderId.toString()}`
						);
						orderList.remove(orderId);
						printTopOfOrdersList(ordersLists.asc, ordersLists.desc);
					}
				} else if (orderIsRiskIncreasing && order.reduceOnly) {
					if (openOrders.has(orderId) && orderList.has(orderId)) {
						console.log(
							`Order ${order.orderId.toString()} is risk increasing but reduce only. Removing`
						);
						orderList.remove(orderId);
						printTopOfOrdersList(ordersLists.asc, ordersLists.desc);
					}
				} else {
					if (openOrders.has(orderId) && !orderList.has(orderId)) {
						console.log(`Order ${order.orderId.toString()} added back`);
						orderList.insert(
							order,
							userAccountPublicKey,
							userOrdersAccountPublicKey
						);
						printTopOfOrdersList(ordersLists.asc, ordersLists.desc);
					}
				}
			});
		}
		return marginRatio;
	};

	const userMap = new Map<
		string,
		User
	>();

	const fetchAllUsers = async () => {

		const programUserAccounts = await clearingHouse.program.account.user.all();
		const userOrderAccounts = await clearingHouse.program.account.userOrders.all();
		const userPositionsAccounts = await clearingHouse.program.account.userPositions.all();


		await Promise.all(programUserAccounts.map(async (programUserAccount : ProgramAccount<UserAccount>) => {
			const userAccountPubkey = programUserAccount.publicKey;
			// if the user has less than one dollar in account, disregard initially
			// if an order comes from this user, we can add them then.
			// This makes it so that we don't need to listen to inactive users
			if (!programUserAccount.account.collateral.lt(QUOTE_PRECISION) && !userMap.has(userAccountPubkey.toBase58())) {
				const userOrdersAccount = userOrderAccounts.find((x : ProgramAccount<UserOrdersAccount>) => x.account.user.toBase58() === userAccountPubkey.toBase58()) as ProgramAccount<UserOrdersAccount>;
				if (userOrdersAccount !== undefined) {
					const userPositionsAccount = userPositionsAccounts.find((x : ProgramAccount<UserPositionsAccount>) => x.account.user.toBase58() === userAccountPubkey.toBase58()) as ProgramAccount<UserPositionsAccount>;

					const user = {
						publicKey: userAccountPubkey.toBase58(),
						orders: userOrdersAccount.publicKey.toBase58(),
						positions: userPositionsAccount.publicKey.toBase58(),
						userAccount: programUserAccount.account,
						ordersAccount: userOrdersAccount.account,
						positionsAccount: userPositionsAccount.account,
						upToDate: true
					} as User;
		
					user.ordersAccount.orders.forEach(async order => {
						if (!isVariant(order, 'init') && !isVariant(order.orderType, 'market')) {
							marketOrderLists.get(order.marketIndex.toNumber())[sortDirectionForOrder(order)].insert(order, programUserAccount.publicKey, new PublicKey(user.orders));
						}
			
						const ordersList = marketOrderLists.get(order.marketIndex.toNumber());
						const sortDirection = sortDirectionForOrder(order);
						const orderList = sortDirection === 'desc' ? ordersList.desc : ordersList.asc;
						orderList.insert(order, programUserAccount.publicKey, userOrdersAccount.publicKey);
						if (isVariant(order.status, 'open')) {
							openOrders.add(order.orderId.toNumber());
						}
					});
		
					userMap.set( userAccountPubkey.toBase58(), user );
		
					pollingAccountSubscriber.addAccountToPoll(user.publicKey, 'user', user.publicKey, (data: UserAccount) => {
		
						const newData = { ...userMap.get(user.publicKey), accountData: data } as User;
						userMap.set(user.publicKey, newData);
		
					});
			
					pollingAccountSubscriber.addAccountToPoll(user.publicKey, 'userPositions', user.positions, (data: UserPositionsAccount) => {
		
						const newData = { ...userMap.get(user.publicKey), positionsAccount: data } as User;
						newData.marginRatio = updateUserOrders(user, new PublicKey(user.publicKey), new PublicKey(user.orders));
						
						userMap.set(user.publicKey, newData);
		
					});
			
					pollingAccountSubscriber.addAccountToPoll(user.publicKey, 'userOrders', user.orders, (data: UserOrdersAccount) => {
		
						const newData = { ...userMap.get(user.publicKey), ordersAccount: data } as User;
						newData.marginRatio = getMarginRatio(clearingHouse, newData);
						userMap.set(user.publicKey, newData);
		
					});
				}
				
			}
		}));
		if (!pollingAccountSubscriber.isSubscribed) {
			pollingAccountSubscriber.subscribe();
		}

	};
	console.log('fetching all users');
	await fetchAllUsers();

	setInterval(() => {
		fetchAllUsers();
	}, 30 * 1000);

	printOrderLists();

	setInterval(() => {
		userMap.forEach(async user => {
			userMap.set(user.publicKey, { ...user, marginRatio: getMarginRatio(clearingHouse, user) });
		});
	}, 1500);
	

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
			openOrders.add(order.orderId.toNumber());
			console.log(
				`Order ${order.orderId.toString()} placed. Added to order list`
			);
		} else if (isVariant(record.action, 'cancel')) {
			orderList.remove(order.orderId.toNumber());
			openOrders.delete(order.orderId.toNumber());
			console.log(
				`Order ${order.orderId.toString()} canceled. Removed from order list`
			);
		} else if (isVariant(record.action, 'fill')) {
			if (order.baseAssetAmount.eq(order.baseAssetAmountFilled)) {
				orderList.remove(order.orderId.toNumber());
				openOrders.delete(order.orderId.toNumber());
				console.log(
					`Order ${order.orderId.toString()} completely filled. Removed from order list`
				);
			} else {
				orderList.update(order);
				console.log(
					`Order ${order.orderId.toString()} partially filled. Updated`
				);
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

	const findNodesToFill = async (
		node: Node,
		markPrice: BN
	): Promise<Node[]> => {
		const nodesToFill = [];
		let currentNode = node;
		while (currentNode !== undefined) {
			if (!currentNode.pricesCross(markPrice)) {
				currentNode = undefined;
				break;
			}

			const mapValue = userMap.get(node.userAccount.toString());
			if (mapValue) {
				if (!currentNode.haveFilled && mapValue.upToDate) {
					nodesToFill.push(currentNode);
				}
			}

			currentNode = currentNode.next;
		}

		return nodesToFill;
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

		const nodesToFill: Node[] = [];
		if (orderLists.asc.head && orderLists.asc.head.pricesCross(markPrice)) {
			nodesToFill.push(
				...(await findNodesToFill(orderLists.asc.head, markPrice))
			);
		}

		if (orderLists.desc.head && orderLists.desc.head.pricesCross(markPrice)) {
			nodesToFill.push(
				...(await findNodesToFill(orderLists.desc.head, markPrice))
			);
		}

		nodesToFill
			.filter((nodeToFill) => !nodeToFill.haveFilled)
			.forEach(async (nodeToFill) => {
				userMap.set(nodeToFill.userAccount.toString(), { ...userMap.get(nodeToFill.userAccount.toString()), upToDate: false });
				nodeToFill.haveFilled = true;

				console.log(
					`trying to fill (account: ${nodeToFill.userAccount.toString()})`
				);

				const tx = new Transaction();
				
				// const clock = await getClock(connection);

				// const maxOrderFillPossible = calculateAmountToTrade(market, nodeToFill.order);

				// const [fillOrderNewQuoteAssetReserve,] = calculateAmmReservesAfterSwap(market.amm, 'base', maxOrderFillPossible, SwapDirection.REMOVE);
				// const maxPossibleFillOrderQuoteAmount = (fillOrderNewQuoteAssetReserve.sub(market.amm.quoteAssetReserve)).mul(PEG_PRECISION).div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO);
				// const maxLimitOrderFee = calculateFeeForLimitOrder(maxPossibleFillOrderQuoteAmount, clearingHouse.getStateAccount().feeStructure, clearingHouse.getOrderStateAccount().orderFillerRewardStructure, calculateOrderFeeTier(clearingHouse.getStateAccount().feeStructure), nodeToFill.order.ts, clock.unixTimestamp);
				
				// const [, fillerRewardNewBaseAssetReserve] =  calculateAmmReservesAfterSwap(market.amm, 'quote', maxLimitOrderFee.fillerReward, SwapDirection.ADD);

				// const newMarket = calculateNewMarketAfterTrade((maxOrderFillPossible.add((fillerRewardNewBaseAssetReserve.mul(PEG_PRECISION).div(AMM_TIMES_PEG_TO_QUOTE_PRECISION_RATIO)))), nodeToFill.order.direction, market);

				// const marketPrice = convertToNumber(markPrice, MARK_PRICE_PRECISION);
				// const marketPriceAfter = convertToNumber(calculateMarkPrice(newMarket), MARK_PRICE_PRECISION);
				// const spread = Math.abs(marketPrice - marketPriceAfter);
				// const maxFillerReward = convertToNumber(maxLimitOrderFee.fillerReward, new BN(10 ** 6));
				// const maxFrontRunQuoteAmount = (maxFillerReward + (spread)) * (10 ** 6);

				// console.log(convertToNumber(limitOrderFee.fillerReward, new BN(10 ** 6)), quoteSwapAmount.div(AMM_RESERVE_PRECISION).toNumber(), nodeToFill.order.baseAssetAmount.div(AMM_RESERVE_PRECISION).toNumber(), nodeToFill.order.ts.toNumber(), clock.unixTimestamp.toNumber());
				// console.log((((nodeToFill.order.baseAssetAmount.sub(nodeToFill.order.baseAssetAmountFilled)).div(new BN(10 ** 7))).mul(new BN(convertToNumber(markPrice, MARK_PRICE_PRECISION)))).toNumber());
				// frontRun.add(await clearingHouse.getOpenPositionIx(nodeToFill.order.direction, ((nodeToFill.order.baseAssetAmount.sub(nodeToFill.order.baseAssetAmountFilled)).div(new BN(10 ** 7))).mul(new BN(convertToNumber(markPrice, MARK_PRICE_PRECISION))), nodeToFill.order.marketIndex));
				// frontRun.add(await clearingHouse.getOpenPositionIx(nodeToFill.order.direction, frontRunQuoteAmount, nodeToFill.order.marketIndex));
				// console.log(convertToNumber(maxOrderFillPossible, BASE_PRECISION), spread, maxFillerReward, marketPrice, marketPriceAfter, maxFrontRunQuoteAmount);
				tx.add(await clearingHouse.getFillOrderIx(nodeToFill.userAccount, nodeToFill.userOrdersAccount, nodeToFill.order));
				
				// frontRun.add(await clearingHouse.getClosePositionIx(nodeToFill.order.marketIndex));
				try {
					const txSig = await clearingHouse.txSender.send(tx, [], clearingHouse.opts);
					console.log(
						`Filled user (account: ${nodeToFill.userAccount.toString()}) order: ${nodeToFill.order.orderId.toString()}`
					);
					console.log(`Tx: ${txSig}`);
					cloudWatchClient.logFill(true);
				} catch(error) {
					nodeToFill.haveFilled = false;
					userMap.set(nodeToFill.userAccount.toString(), { ...userMap.get(nodeToFill.userAccount.toString()), upToDate: true });
					console.log(
						`Error filling user (account: ${nodeToFill.userAccount.toString()}) order: ${nodeToFill.order.orderId.toString()}`
					);
					cloudWatchClient.logFill(false);

					// If we get an error that order does not exist, assume its been filled by somebody else and we
					// have received the history record yet
					const errorCode = getErrorCode(error);
					if (errorCode === 6043) {
						console.log(
							`Order ${nodeToFill.order.orderId.toString()} not found when trying to fill. Removing from order list`
						);
						orderLists[nodeToFill.sortDirection].remove(
							nodeToFill.order.orderId.toNumber()
						);
						printTopOfOrdersList(orderLists.asc, orderLists.desc);
					}
				}
			});
		perMarketMutex[marketIndex.toNumber()] = 0;
	};

	const tryFill = () => {
		Markets.forEach(async market => {
			tryFillForMarket(market.marketIndex);
		});
	};

	tryFill();
	const handleFillIntervalId = setInterval(tryFill, 500); // every half second
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

const pollingAccountSubscriber = new PollingAccountSubscriber('main', clearingHouse.program, 0, 5000);

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
	return new Promise((resolve, reject) => {
		connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'processed').then(clockAccountInfo => {
			const decoded = CLOCK_LAYOUT.decode(Uint8Array.from(clockAccountInfo.data));
			resolve({
				slot: uint8ToU64(decoded.slot),
				epochStartTimestamp: uint8ToU64(decoded.epochStartTimestamp),
				epoch: uint8ToU64(decoded.epoch),
				leaderScheduleEpoch: uint8ToU64(decoded.leaderScheduleEpoch),
				unixTimestamp: uint8ToU64(decoded.unixTimestamp),
			} as Clock);
		}).catch(error => {
			reject(error);
		});
	});
};

getClock(connection).then(clock => {
	console.log(clock.unixTimestamp.toNumber());
}).catch(error => {
	console.error(error);
});

recursiveTryCatch(() => runBot(wallet, clearingHouse));