"use strict";

import { BN, ProgramAccount, Provider } from '@project-serum/anchor';
// import * as BufferLayout from '@solana/buffer-layout';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
// import { u64 } from "@solana/spl-token";

import {
	BulkAccountLoader,
	ClearingHouse,
	initialize,
	isVariant,
	Markets,
	UserOrdersAccount,
	OrderRecord,
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
	TWO
} from '@drift-labs/sdk';
import { PollingAccountsFetcher } from 'polling-account-fetcher';
import { TpuConnection } from 'tpu-client';

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

function calculatePositionPNL(
	market: Market,
	marketPosition: UserPosition,
    baseAssetValue: BN,
	withFunding = false
): BN  {
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
}

function getMarginRatio(clearingHouse : ClearingHouse, user: User) {
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
}


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

interface User {
	marginRatio: BN,
	publicKey: string,
	positions: string,
	orders: string,
	userAccount: UserAccount
	positionsAccount: UserPositionsAccount
	ordersAccount: UserOrdersAccount,
	upToDate: boolean
	authority: string
}

interface UnconfirmedTransaction {
	tx: string,
	timestamp: number
}

export class OrderFiller {
	clearingHouse: ClearingHouse;
	connection: TpuConnection;
	wallet: Wallet;
	lamportsBalance: number;
	marketOrderLists: Map<number, { desc: OrderList, asc: OrderList }>;
	openOrders: Set<number>;
	nextOrderHistoryIndex: number;
	userMap: Map<string, User>;
	pollingAccountSubscriber: PollingAccountsFetcher;
	perMarketMutex: Array<number>;
	updateOrderListMutex: number;
	intervalIds: Array<NodeJS.Timer>;
	running: boolean;
	blacklist: Array<string> = [];
	blockhash: string
	transactions: Map<string, UnconfirmedTransaction> = new Map<string, UnconfirmedTransaction>();
	constructor(wallet: Wallet, clearingHouse: ClearingHouse, connection: TpuConnection) {
		this.clearingHouse = clearingHouse;
		this.connection = connection;
		this.wallet = wallet;
		this.marketOrderLists = new Map<number, { desc: OrderList, asc: OrderList }>();
		this.openOrders = new Set<number>();
		this.nextOrderHistoryIndex = clearingHouse.getOrderHistoryAccount().head.toNumber();
		this.userMap = new Map<string, User>();
		this.pollingAccountSubscriber = new PollingAccountsFetcher(process.env.ENDPOINT, 5000);
		this.perMarketMutex = new Array(64).fill(0);
		this.intervalIds = new Array<NodeJS.Timer>();
		this.running = false;

		Markets.forEach(market => {
			this.marketOrderLists.set(market.marketIndex.toNumber(), {
				desc: new OrderList(market.marketIndex, 'desc'), // longs
				asc: new OrderList(market.marketIndex, 'asc'), // shorts
			});
		});
		
		
	}
	sleep(ms : number) : Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	
	async recursiveTryCatch(f: () => Promise<void>) : Promise<void> {
		try {
			await (f.bind(this))();
		} catch (e) {
			console.error(e);
			this.intervalIds.forEach(i => clearInterval(i));
			await this.sleep(15000);
			await this.recursiveTryCatch(f.bind(this));
		}
	}
	start () : void {
		if (!this.running) {
			this.running = true;
			this.recursiveTryCatch(this.runBot.bind(this));
		} else {
			console.log('order filler is already running');
		}
		
	}
	stop () : void {
		if (this.running) {
			this.running = false;
			this.intervalIds.forEach(i => clearInterval(i));
		} else {
			console.log('order filler is not running');
		}
		
	}
	async runBot () : Promise<void> {

		console.log('fetching all users');
		await this.fetchAllUsers();

		this.intervalIds.push(setInterval(() => {
			this.fetchAllUsers();
		}, 60 * 30 * 1000));

		this.intervalIds.push(setInterval(() => {
			this.userMap.forEach(async user => {
				this.userMap.set(user.publicKey, { ...user, marginRatio: getMarginRatio(this.clearingHouse, user) } as User);
			});
		}, 500));

		this.intervalIds.push(setInterval(async () => {
			this.blockhash = (await this.clearingHouse.connection.getRecentBlockhash()).blockhash;
		}, 1000));

		this.printOrderLists();

		this.clearingHouse.eventEmitter.on('orderHistoryAccountUpdate', this.updateOrderList.bind(this));
		await this.updateOrderList();

		this.tryFill();
		this.intervalIds.push(setInterval((this.tryFill.bind(this)), 500));

		this.intervalIds.push(setInterval((async () => {
			[...this.transactions.keys()].forEach(async (key, index) => {
				setTimeout(async () => {
					const unconfirmedTransaction = this.transactions.get(key);
					if ((unconfirmedTransaction.timestamp + 30 * 1000) < Date.now()) {
						try {
							const confirmation = await this.connection.confirmTransaction(unconfirmedTransaction.tx);
							if(confirmation.value.err) {
								this.transactions.delete(key);
							} else {
								console.log('https://solscan.io/tx/'+unconfirmedTransaction.tx);
							}
							
						} catch(error) {
							console.error(error);
						}
						this.transactions.delete(key);
					}
				}, index * 1000);
			});
		}), 30 * 1000));
	}
	static async load(wallet: Wallet, clearingHouse: ClearingHouse, connection: TpuConnection) : Promise<OrderFiller> {
		await clearingHouse.subscribe(['orderHistoryAccount']);
		
		return new OrderFiller(wallet, clearingHouse, connection);
	}
	async getBalance() : Promise<number> {
		return await this.clearingHouse.connection.getBalance(this.wallet.publicKey);
	}
	async printBalance() : Promise<void> {
		this.lamportsBalance = await this.getBalance();
		console.log('SOL balance:', this.lamportsBalance / 10 ** 9);
	}
	printTopOfOrdersList(asc: OrderList, desc: OrderList) : void {
		console.log(`Market ${Markets[desc.marketIndex.toNumber()].symbol}`);
		desc.printTop();
		console.log(
			`Mark`,
			convertToNumber(
				calculateMarkPrice(this.clearingHouse.getMarket(desc.marketIndex)),
				MARK_PRICE_PRECISION
			).toFixed(3)
		);
		asc.printTop();
	}
	printOrderLists() : void {
		[...this.marketOrderLists.values()].forEach(ordersList => {
			this.printTopOfOrdersList(ordersList.asc, ordersList.desc);
		});
	}
	updateUserOrders(user: User, userAccountPublicKey: PublicKey, userOrdersAccountPublicKey: PublicKey) : BN {
		const marginRatio = getMarginRatio(this.clearingHouse, user);

		const userOrdersAccount = user.ordersAccount;

		if (userOrdersAccount) {
			const tooMuchLeverage = marginRatio.lte(
				this.clearingHouse.getStateAccount().marginRatioInitial
			);

			userOrdersAccount.orders.forEach(async order => {
				const ordersLists = this.marketOrderLists.get(order.marketIndex.toNumber());
				const orderList = ordersLists[sortDirectionForOrder(order)];
				const orderIsRiskIncreasing = isOrderRiskIncreasing(user.positionsAccount, order);

				const orderId = order.orderId.toNumber();
				if (tooMuchLeverage && orderIsRiskIncreasing) {
					if (this.openOrders.has(orderId) && orderList.has(orderId)) {
						console.log(
							`User has too much leverage and order is risk increasing. Removing order ${order.orderId.toString()}`
						);
						orderList.remove(orderId);
						this.printTopOfOrdersList(ordersLists.asc, ordersLists.desc);
					}
				} else if (orderIsRiskIncreasing && order.reduceOnly) {
					if (this.openOrders.has(orderId) && orderList.has(orderId)) {
						console.log(
							`Order ${order.orderId.toString()} is risk increasing but reduce only. Removing`
						);
						orderList.remove(orderId);
						this.printTopOfOrdersList(ordersLists.asc, ordersLists.desc);
					}
				} else if (user.userAccount.collateral.eq(ZERO)) {
					if (this.openOrders.has(orderId) && orderList.has(orderId)) {
						console.log(
							`Removing order ${order.orderId.toString()} as authority ${user.authority} has no collateral`
						);
						orderList.remove(orderId);
						this.printTopOfOrdersList(ordersLists.asc, ordersLists.desc);
					}
				} else {
					if (this.openOrders.has(orderId) && !orderList.has(orderId)) {
						console.log(`Order ${order.orderId.toString()} added back`);
						orderList.insert(
							order,
							userAccountPublicKey,
							userOrdersAccountPublicKey
						);
						this.printTopOfOrdersList(ordersLists.asc, ordersLists.desc);
					}
				}
			});
		}
		return marginRatio;
	}
	async fetchAllUsers() : Promise<void> {
		const programUserAccounts = await this.clearingHouse.program.account.user.all();
		const userOrderAccounts = await this.clearingHouse.program.account.userOrders.all();
		const userPositionsAccounts = await this.clearingHouse.program.account.userPositions.all();


		programUserAccounts.forEach(async (programUserAccount : ProgramAccount<UserAccount>) => {
			const userAccountPubkey = programUserAccount.publicKey;
			// if the user has less than one dollar in account, disregard initially
			// if an order comes from this user, we can add them then.
			// This makes it so that we don't need to listen to inactive users
			if (!this.blacklist.includes(userAccountPubkey.toBase58()) && !programUserAccount.account.collateral.lt(QUOTE_PRECISION) && !this.userMap.has(userAccountPubkey.toBase58())) {
				const userOrdersAccount = userOrderAccounts.find((x : ProgramAccount<UserOrdersAccount>) => x.account.user.toBase58() === userAccountPubkey.toBase58()) as ProgramAccount<UserOrdersAccount>;
				if (userOrdersAccount !== undefined) {
					const userPositionsAccount = userPositionsAccounts.find((x : ProgramAccount<UserPositionsAccount>) => x.account.user.toBase58() === userAccountPubkey.toBase58()) as ProgramAccount<UserPositionsAccount>;

					const user = {
						authority: programUserAccount.account.authority.toBase58(),
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
							this.marketOrderLists.get(order.marketIndex.toNumber())[sortDirectionForOrder(order)].insert(order, programUserAccount.publicKey, new PublicKey(user.orders));
						}
			
						const ordersList = this.marketOrderLists.get(order.marketIndex.toNumber());
						const sortDirection = sortDirectionForOrder(order);
						const orderList = sortDirection === 'desc' ? ordersList.desc : ordersList.asc;
						orderList.insert(order, programUserAccount.publicKey, userOrdersAccount.publicKey);
						if (isVariant(order.status, 'open')) {
							this.openOrders.add(order.orderId.toNumber());
						}
					});
		
					this.userMap.set( userAccountPubkey.toBase58(), user );
		
					this.pollingAccountSubscriber.addProgram('user', user.publicKey, this.clearingHouse.program as any, (data: UserAccount) => {
		
						const newData = { ...this.userMap.get(user.publicKey), accountData: data } as User;
						this.userMap.set(user.publicKey, newData);
		
					}, (error: any) => {
						console.error(error);
					});
			
					this.pollingAccountSubscriber.addProgram('userPositions', user.positions, this.clearingHouse.program as any,  (data: UserPositionsAccount) => {
		
						const newData = { ...this.userMap.get(user.publicKey), positionsAccount: data } as User;
						newData.marginRatio = this.updateUserOrders(user, new PublicKey(user.publicKey), new PublicKey(user.orders));
						
						this.userMap.set(user.publicKey, newData);
		
					}, (error: any) => {
						console.error(error);
					});
			
					this.pollingAccountSubscriber.addProgram('userOrders', user.orders, this.clearingHouse.program as any,  (data: UserOrdersAccount) => {
		
						const newData = { ...this.userMap.get(user.publicKey), ordersAccount: data } as User;
						newData.marginRatio = this.updateUserOrders(user, new PublicKey(user.publicKey), new PublicKey(user.orders));
						this.userMap.set(user.publicKey, newData);
		
					}, (error: any) => {
						console.error(error);
					});
				}
				
			}
		});
		this.pollingAccountSubscriber.start();
	}
	async handleOrderRecord(record: OrderRecord) : Promise<void> {
		if (record !== undefined) {
			const order = record.order;
			// Disregard market orders
			if (isVariant(order.orderType, 'market')) {
				return;
			}

			const ordersList = this.marketOrderLists.get(order.marketIndex.toNumber());
			const orderList = ordersList[sortDirectionForOrder(order)];

			if (isVariant(record.action, 'place')) {
				// const userOrdersAccountPublicKey = await getUserOrdersAccountPublicKey(
				// 	this.clearingHouse.program.programId,
				// 	record.user
				// );
				const user = [...this.userMap.values()].find(u => u.publicKey === record.user.toBase58());
				orderList.insert(order, record.user, new PublicKey(user.orders));
				this.openOrders.add(order.orderId.toNumber());
				console.log(
					`Order ${order.orderId.toString()} placed. Added to order list`
				);
			} else if (isVariant(record.action, 'cancel')) {
				orderList.remove(order.orderId.toNumber());
				this.openOrders.delete(order.orderId.toNumber());
				console.log(
					`Order ${order.orderId.toString()} canceled. Removed from order list`
				);
			} else if (isVariant(record.action, 'fill')) {
				if (order.baseAssetAmount.eq(order.baseAssetAmountFilled)) {
					orderList.remove(order.orderId.toNumber());
					this.openOrders.delete(order.orderId.toNumber());
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
			this.printTopOfOrdersList(ordersList.asc, ordersList.desc);
		}
		
		
	}

	async updateOrderList() : Promise<void> {
		if (this.updateOrderListMutex === 1) {
			return;
		}
		this.updateOrderListMutex = 1;

		let head = this.clearingHouse.getOrderHistoryAccount().head.toNumber();
		const orderHistoryLength = this.clearingHouse.getOrderHistoryAccount().orderRecords.length;
		while (this.nextOrderHistoryIndex !== head) {
			const nextRecord =
			this.clearingHouse.getOrderHistoryAccount().orderRecords[
					this.nextOrderHistoryIndex
				];
			await this.handleOrderRecord(nextRecord);
			this.nextOrderHistoryIndex += (1 % orderHistoryLength);
			head = this.clearingHouse.getOrderHistoryAccount().head.toNumber();
		}
		this.updateOrderListMutex = 0;
	}
	async findNodesToFill(
		node: Node,
		markPrice: BN
	): Promise<Node[]> {
		const nodesToFill = [];
		let currentNode = node;
		while (currentNode !== undefined) {
			if (!currentNode.pricesCross(markPrice)) {
				currentNode = undefined;
				break;
			}

			const mapValue = this.userMap.get(node.userAccount.toString());
			if (mapValue) {
				if (!currentNode.haveFilled && mapValue.upToDate) {
					nodesToFill.push(currentNode);
				}
			}

			currentNode = currentNode.next;
		}

		return nodesToFill;
	}
	async tryFillForMarket(marketIndex: BN) : Promise<void> {
		if (this.perMarketMutex[marketIndex.toNumber()] === 1) {
			return;
		}
		this.perMarketMutex[marketIndex.toNumber()] = 1;

		const market = this.clearingHouse.getMarket(marketIndex);
		const orderLists = this.marketOrderLists.get(marketIndex.toNumber());
		const markPrice = calculateMarkPrice(market);

		const nodesToFill: Node[] = [];
		if (orderLists.asc.head && orderLists.asc.head.pricesCross(markPrice)) {
			nodesToFill.push(
				...(await this.findNodesToFill(orderLists.asc.head, markPrice))
			);
		}

		if (orderLists.desc.head && orderLists.desc.head.pricesCross(markPrice)) {
			nodesToFill.push(
				...(await this.findNodesToFill(orderLists.desc.head, markPrice))
			);
		}

		nodesToFill
			.filter((nodeToFill) => !nodeToFill.haveFilled)
			.forEach(async (nodeToFill) => {
				this.userMap.set(nodeToFill.userAccount.toString(), { ...this.userMap.get(nodeToFill.userAccount.toString()), upToDate: false });
				nodeToFill.haveFilled = true;

				console.log(
					`trying to fill (account: ${nodeToFill.userAccount.toString()})`
				);

				let tx = new Transaction();
				
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
				tx.add(await this.clearingHouse.getFillOrderIx(nodeToFill.userAccount, nodeToFill.userOrdersAccount, nodeToFill.order));
				
				// frontRun.add(await clearingHouse.getClosePositionIx(nodeToFill.order.marketIndex));
				try {
					tx.recentBlockhash = this.blockhash;
					tx.feePayer = this.wallet.publicKey;
					tx = await this.clearingHouse.wallet.signTransaction(tx);
					const txSig = await this.connection.sendRawTransaction(tx.serialize());
					this.transactions.set(txSig, { tx: txSig, timestamp: Date.now() } as UnconfirmedTransaction);
					cloudWatchClient.logFill(true);
				} catch(error) {
					nodeToFill.haveFilled = false;
					this.userMap.set(nodeToFill.userAccount.toString(), { ...this.userMap.get(nodeToFill.userAccount.toString()), upToDate: true });
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
						this.printTopOfOrdersList(orderLists.asc, orderLists.desc);
					} else if (errorCode === 6046) {
						console.log(`Order ${nodeToFill.order.orderId.toString()} -- ReduceOnlyOrderIncreasedRisk`);
					}
				}
			});
			this.perMarketMutex[marketIndex.toNumber()] = 0;
	}
	tryFill() : void {
		Markets.forEach(async market => {
			this.tryFillForMarket(market.marketIndex);
		});
	}

}


setInterval(() => {
	console.log(`total mem usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
}, 10 * 1000);

function memoryRestart(orderFiller: OrderFiller) {
	setTimeout(() => {
		if ((process.memoryUsage().heapUsed / 1024 / 1024) > 3000) {
			orderFiller.stop();
			orderFiller = undefined;
			main();
		} else {
			memoryRestart(orderFiller);
		}
	}, 60 * 1000);
}

async function main() {

	const endpoint = process.env.ENDPOINT;
	const connection = await TpuConnection.load(endpoint);
	const wallet = getWallet();
	const provider = new Provider(connection, wallet, Provider.defaultOptions());
	const clearingHousePublicKey = new PublicKey(
		sdkConfig.CLEARING_HOUSE_PROGRAM_ID
	);

	const clearingHouse = getClearingHouse(
		getPollingClearingHouseConfig(

			provider.connection,
			provider.wallet,
			clearingHousePublicKey,
			new BulkAccountLoader(provider.connection, 'confirmed', 500)

		)
	);

	const orderFiller = await OrderFiller.load(wallet, clearingHouse, connection);
	orderFiller.start();

	memoryRestart(orderFiller);
}

main();

// const pollingAccountSubscriber = new PollingAccountSubscriber('pollingAccountSubscriber', clearingHouse.program, 0, 5000);

// const uint64 = (property = "uint64") => {
//     return BufferLayout.blob(8, property);
// };

// function uint8ToU64(data) {
//     return new u64(data, 10, "le");
// }


// const CLOCK_LAYOUT = BufferLayout.struct([
// 	uint64('slot'),
// 	uint64('epochStartTimestamp'),
// 	uint64('epoch'),
// 	uint64('leaderScheduleEpoch'),
// 	uint64('unixTimestamp')

// ]);

// interface Clock {
// 	slot: u64,
// 	epochStartTimestamp: u64,
// 	epoch: u64,
// 	leaderScheduleEpoch: u64,
// 	unixTimestamp: u64
// }

// const getClock = ( connection: Connection ) : Promise<Clock> => {
// 	return new Promise((resolve, reject) => {
// 		connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY, 'processed').then(clockAccountInfo => {
// 			const decoded = CLOCK_LAYOUT.decode(Uint8Array.from(clockAccountInfo.data));
// 			resolve({
// 				slot: uint8ToU64(decoded.slot),
// 				epochStartTimestamp: uint8ToU64(decoded.epochStartTimestamp),
// 				epoch: uint8ToU64(decoded.epoch),
// 				leaderScheduleEpoch: uint8ToU64(decoded.leaderScheduleEpoch),
// 				unixTimestamp: uint8ToU64(decoded.unixTimestamp),
// 			} as Clock);
// 		}).catch(error => {
// 			reject(error);
// 		});
// 	});
// };

// getClock(connection).then(clock => {
// 	console.log(clock.unixTimestamp.toNumber());
// }).catch(error => {
// 	console.error(error);
// });

