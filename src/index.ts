import { program, Option } from 'commander';

import responseTime = require('response-time');
import express from 'express';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import morgan from 'morgan';
import cors from 'cors';

import { Connection, Commitment, PublicKey } from '@solana/web3.js';

import {
	getVariant,
	BulkAccountLoader,
	DriftClient,
	initialize,
	DriftEnv,
	SlotSubscriber,
	UserMap,
	DLOBOrder,
	DLOBOrders,
	DLOBOrdersCoder,
	SpotMarkets,
	PerpMarkets,
	DLOBSubscriber,
	MarketType,
	SpotMarketConfig,
	PhoenixSubscriber,
	SerumSubscriber,
	DLOBNode,
	isVariant,
} from '@drift-labs/sdk';

import { Mutex } from 'async-mutex';

import { getWallet } from './utils';
import { logger, setLogLevel } from './logger';

import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import {
	ExplicitBucketHistogramAggregation,
	InstrumentType,
	MeterProvider,
	View,
} from '@opentelemetry/sdk-metrics-base';
import { ObservableResult } from '@opentelemetry/api';

require('dotenv').config();
const driftEnv = (process.env.ENV || 'devnet') as DriftEnv;
const commitHash = process.env.COMMIT;
//@ts-ignore
const sdkConfig = initialize({ env: process.env.ENV });

const stateCommitment: Commitment = 'confirmed';
const serverPort = process.env.PORT || 6969;

const bulkAccountLoaderPollingInterval = process.env
	.BULK_ACCOUNT_LOADER_POLLING_INTERVAL
	? parseInt(process.env.BULK_ACCOUNT_LOADER_POLLING_INTERVAL)
	: 5000;
const healthCheckInterval = bulkAccountLoaderPollingInterval * 2;

const rateLimitCallsPerSecond = process.env.RATE_LIMIT_CALLS_PER_SECOND
	? parseInt(process.env.RATE_LIMIT_CALLS_PER_SECOND)
	: 10;

const logFormat =
	':remote-addr - :remote-user [:date[clf]] ":method :url HTTP/:http-version" :status :res[content-length] ":referrer" ":user-agent" :req[x-forwarded-for]';
const logHttp = morgan(logFormat, {
	skip: (_req, res) => res.statusCode < 400,
});

function errorHandler(err, _req, res, _next) {
	logger.error(err.stack);
	res.status(500).send('Internal error');
}

const app = express();
app.use(cors({ origin: '*' }));
app.use(compression());
app.set('trust proxy', 1);
app.use(logHttp);

app.use(
	rateLimit({
		windowMs: 1000, // 1 second
		max: rateLimitCallsPerSecond,
		standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
		legacyHeaders: false, // Disable the `X-RateLimit-*` headers
	})
);

// strip off /dlob, if the request comes from exchange history server LB
app.use((req, _res, next) => {
	if (req.url.startsWith('/dlob')) {
		req.url = req.url.replace('/dlob', '');
		if (req.url === '') {
			req.url = '/';
		}
	}
	next();
});

program
	.option('-d, --dry-run', 'Dry run, do not send transactions on chain')
	.option('--test-liveness', 'Purposefully fail liveness test after 1 minute')
	.addOption(
		new Option(
			'-p, --private-key <string>',
			'private key, supports path to id.json, or list of comma separate numbers'
		).env('ANCHOR_PRIVATE_KEY')
	)
	.option('--debug', 'Enable debug logging')
	.parse();

const opts = program.opts();
setLogLevel(opts.debug ? 'debug' : 'info');

const endpoint = process.env.ENDPOINT;
const wsEndpoint = process.env.WS_ENDPOINT;
logger.info(`RPC endpoint: ${endpoint}`);
logger.info(`WS endpoint:  ${wsEndpoint}`);
logger.info(`DriftEnv:     ${driftEnv}`);
logger.info(`Commit:       ${commitHash}`);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Creates {count} buckets of size {increment} starting from {start}. Each bucket stores the count of values within its "size".
 * @param start
 * @param increment
 * @param count
 * @returns
 */
const createHistogramBuckets = (
	start: number,
	increment: number,
	count: number
) => {
	return new ExplicitBucketHistogramAggregation(
		Array.from(new Array(count), (_, i) => start + i * increment)
	);
};

enum METRIC_TYPES {
	runtime_specs = 'runtime_specs',
	endpoint_response_times_histogram = 'endpoint_response_times_histogram',
	health_status = 'health_status',
}

export enum HEALTH_STATUS {
	Ok = 0,
	StaleBulkAccountLoader,
	UnhealthySlotSubscriber,
	LivenessTesting,
}

const metricsPort =
	parseInt(process.env.METRICS_PORT) || PrometheusExporter.DEFAULT_OPTIONS.port;
const { endpoint: defaultEndpoint } = PrometheusExporter.DEFAULT_OPTIONS;
const exporter = new PrometheusExporter(
	{
		port: metricsPort,
		endpoint: defaultEndpoint,
	},
	() => {
		logger.info(
			`prometheus scrape endpoint started: http://localhost:${metricsPort}${defaultEndpoint}`
		);
	}
);
const meterName = 'dlob-meter';
const meterProvider = new MeterProvider({
	views: [
		new View({
			instrumentName: METRIC_TYPES.endpoint_response_times_histogram,
			instrumentType: InstrumentType.HISTOGRAM,
			meterName,
			aggregation: createHistogramBuckets(0, 50, 30),
		}),
	],
});
meterProvider.addMetricReader(exporter);
const meter = meterProvider.getMeter(meterName);

const runtimeSpecsGauge = meter.createObservableGauge(
	METRIC_TYPES.runtime_specs,
	{
		description: 'Runtime sepcification of this program',
	}
);
const bootTimeMs = Date.now();
runtimeSpecsGauge.addCallback((obs) => {
	obs.observe(bootTimeMs, {
		commit: commitHash,
		driftEnv,
		rpcEndpoint: endpoint,
		wsEndpoint: wsEndpoint,
	});
});

let healthStatus: HEALTH_STATUS = HEALTH_STATUS.Ok;
const healthStatusGauge = meter.createObservableGauge(
	METRIC_TYPES.health_status,
	{
		description: 'Health status of this program',
	}
);
healthStatusGauge.addCallback((obs: ObservableResult) => {
	obs.observe(healthStatus, {});
});

const endpointResponseTimeHistogram = meter.createHistogram(
	METRIC_TYPES.endpoint_response_times_histogram,
	{
		description: 'Duration of endpoint responses',
		unit: 'ms',
	}
);

const getPhoenixSubscriber = (
	driftClient: DriftClient,
	marketConfig: SpotMarketConfig,
	accountLoader: BulkAccountLoader
) => {
	return new PhoenixSubscriber({
		connection: driftClient.connection,
		programId: new PublicKey(sdkConfig.PHOENIX),
		marketAddress: marketConfig.phoenixMarket,
		accountSubscription: {
			type: 'polling',
			accountLoader,
		},
	});
};

const getSerumSubscriber = (
	driftClient: DriftClient,
	marketConfig: SpotMarketConfig,
	accountLoader: BulkAccountLoader
) => {
	return new SerumSubscriber({
		connection: driftClient.connection,
		programId: new PublicKey(sdkConfig.SERUM_V3),
		marketAddress: marketConfig.serumMarket,
		accountSubscription: {
			type: 'polling',
			accountLoader,
		},
	});
};

type SubscriberLookup = {
	[marketIndex: number]: {
		phoenix?: PhoenixSubscriber;
		serum?: SerumSubscriber;
	};
};

let MARKET_SUBSCRIBERS: SubscriberLookup = {};

const initializeAllMarketSubscribers = async (
	driftClient: DriftClient,
	bulkAccountLoader: BulkAccountLoader
) => {
	const markets: SubscriberLookup = {};

	for (const market of sdkConfig.SPOT_MARKETS) {
		markets[market.marketIndex] = {
			phoenix: undefined,
			serum: undefined,
		};

		if (market.phoenixMarket) {
			const phoenixSubscriber = getPhoenixSubscriber(
				driftClient,
				market,
				bulkAccountLoader
			);
			await phoenixSubscriber.subscribe();
			markets[market.marketIndex].phoenix = phoenixSubscriber;
		}

		if (market.serumMarket) {
			const serumSubscriber = getSerumSubscriber(
				driftClient,
				market,
				bulkAccountLoader
			);
			await serumSubscriber.subscribe();
			markets[market.marketIndex].serum = serumSubscriber;
		}
	}

	return markets;
};

const main = async () => {
	const wallet = getWallet();
	const clearingHousePublicKey = new PublicKey(sdkConfig.DRIFT_PROGRAM_ID);

	const connection = new Connection(endpoint, {
		wsEndpoint: wsEndpoint,
		commitment: stateCommitment,
	});

	const bulkAccountLoader = new BulkAccountLoader(
		connection,
		stateCommitment,
		bulkAccountLoaderPollingInterval
	);
	const lastBulkAccountLoaderSlotMutex = new Mutex();
	let lastBulkAccountLoaderSlot = bulkAccountLoader.mostRecentSlot;
	let lastBulkAccountLoaderSlotUpdated = Date.now();
	const driftClient = new DriftClient({
		connection,
		wallet,
		programID: clearingHousePublicKey,
		perpMarketIndexes: PerpMarkets[driftEnv].map((mkt) => mkt.marketIndex),
		spotMarketIndexes: SpotMarkets[driftEnv].map((mkt) => mkt.marketIndex),
		oracleInfos: PerpMarkets[driftEnv].map((mkt) => {
			return { publicKey: mkt.oracle, source: mkt.oracleSource };
		}),
		accountSubscription: {
			type: 'polling',
			accountLoader: bulkAccountLoader,
		},
		env: driftEnv,
		userStats: true,
	});

	const dlobCoder = DLOBOrdersCoder.create();
	const slotSubscriber = new SlotSubscriber(connection, {});
	const lastSlotReceivedMutex = new Mutex();
	let lastSlotReceived: number;
	let lastHealthCheckSlot = -1;
	let lastHealthCheckSlotUpdated = Date.now();
	const startupTime = Date.now();

	const lamportsBalance = await connection.getBalance(wallet.publicKey);
	logger.info(
		`DriftClient ProgramId: ${driftClient.program.programId.toBase58()}`
	);
	logger.info(`Wallet pubkey: ${wallet.publicKey.toBase58()}`);
	logger.info(` . SOL balance: ${lamportsBalance / 10 ** 9}`);

	await driftClient.subscribe();
	driftClient.eventEmitter.on('error', (e) => {
		logger.info('clearing house error');
		logger.error(e);
	});

	await slotSubscriber.subscribe();
	slotSubscriber.eventEmitter.on('newSlot', async (slot: number) => {
		await lastSlotReceivedMutex.runExclusive(async () => {
			lastSlotReceived = slot;
		});
	});

	if (!(await driftClient.getUser().exists())) {
		logger.error(`User for ${wallet.publicKey} does not exist`);
		if (opts.initUser) {
			logger.info(`Creating User for ${wallet.publicKey}`);
			const [txSig] = await driftClient.initializeUserAccount();
			logger.info(`Initialized user account in transaction: ${txSig}`);
		} else {
			throw new Error("Run with '--init-user' flag to initialize a User");
		}
	}

	const userMap = new UserMap(
		driftClient,
		driftClient.userAccountSubscriptionConfig,
		false
	);
	await userMap.subscribe();

	const dlobSubscriber = new DLOBSubscriber({
		driftClient,
		dlobSource: userMap,
		slotSource: slotSubscriber,
		updateFrequency: bulkAccountLoaderPollingInterval,
	});
	await dlobSubscriber.subscribe();

	const handleResponseTime = responseTime((req: Request, _res, time) => {
		const endpoint = req.url;

		const responseTimeMs = time;
		endpointResponseTimeHistogram.record(responseTimeMs, {
			endpoint,
		});
	});

	MARKET_SUBSCRIBERS = await initializeAllMarketSubscribers(
		driftClient,
		bulkAccountLoader
	);

	// start http server listening to /health endpoint using http package
	app.get('/health', handleResponseTime, async (req, res, next) => {
		try {
			if (req.url === '/health') {
				if (opts.testLiveness) {
					if (Date.now() > startupTime + 60 * 1000) {
						healthStatus = HEALTH_STATUS.LivenessTesting;

						res.writeHead(500);
						res.end('Testing liveness test fail');
						return;
					}
				}
				// check if a slot was received recently
				let healthySlotSubscriber = false;
				await lastSlotReceivedMutex.runExclusive(async () => {
					const slotChanged = lastSlotReceived > lastHealthCheckSlot;
					const slotChangedRecently =
						Date.now() - lastHealthCheckSlotUpdated < healthCheckInterval;
					healthySlotSubscriber = slotChanged || slotChangedRecently;
					logger.debug(
						`Slotsubscriber health check: lastSlotReceived: ${lastSlotReceived}, lastHealthCheckSlot: ${lastHealthCheckSlot}, slotChanged: ${slotChanged}, slotChangedRecently: ${slotChangedRecently}`
					);
					if (slotChanged) {
						lastHealthCheckSlot = lastSlotReceived;
						lastHealthCheckSlotUpdated = Date.now();
					}
				});
				if (!healthySlotSubscriber) {
					healthStatus = HEALTH_STATUS.UnhealthySlotSubscriber;
					logger.error(`SlotSubscriber is not healthy`);

					res.writeHead(500);
					res.end(`SlotSubscriber is not healthy`);
					return;
				}

				if (bulkAccountLoader) {
					let healthyBulkAccountLoader = false;
					await lastBulkAccountLoaderSlotMutex.runExclusive(async () => {
						const slotChanged =
							bulkAccountLoader.mostRecentSlot > lastBulkAccountLoaderSlot;
						const slotChangedRecently =
							Date.now() - lastBulkAccountLoaderSlotUpdated <
							healthCheckInterval;
						healthyBulkAccountLoader = slotChanged || slotChangedRecently;
						logger.debug(
							`BulkAccountLoader health check: bulkAccountLoader.mostRecentSlot: ${bulkAccountLoader.mostRecentSlot}, lastBulkAccountLoaderSlot: ${lastBulkAccountLoaderSlot}, slotChanged: ${slotChanged}, slotChangedRecently: ${slotChangedRecently}`
						);
						if (slotChanged) {
							lastBulkAccountLoaderSlot = bulkAccountLoader.mostRecentSlot;
							lastBulkAccountLoaderSlotUpdated = Date.now();
						}
					});
					if (!healthyBulkAccountLoader) {
						healthStatus = HEALTH_STATUS.StaleBulkAccountLoader;
						logger.error(
							`Health check failed due to stale bulkAccountLoader.mostRecentSlot`
						);

						res.writeHead(501);
						res.end(`bulkAccountLoader.mostRecentSlot is not healthy`);
						return;
					}
				}

				// liveness check passed
				healthStatus = HEALTH_STATUS.Ok;
				res.writeHead(200);
				res.end('OK');
			} else {
				res.writeHead(404);
				res.end('Not found');
			}
		} catch (e) {
			next(e);
		}
	});

	app.get('/orders/json/raw', handleResponseTime, async (_req, res, next) => {
		try {
			// object with userAccount key and orders object serialized
			const orders: Array<any> = [];
			const oracles: Array<any> = [];
			const slot = bulkAccountLoader.mostRecentSlot;

			for (const market of driftClient.getPerpMarketAccounts()) {
				const oracle = driftClient.getOracleDataForPerpMarket(
					market.marketIndex
				);
				oracles.push({
					marketIndex: market.marketIndex,
					...oracle,
				});
			}

			for (const user of userMap.values()) {
				const userAccount = user.getUserAccount();

				for (const order of userAccount.orders) {
					if (isVariant(order.status, 'init')) {
						continue;
					}

					orders.push({
						user: user.getUserAccountPublicKey().toBase58(),
						order: order,
					});
				}
			}

			// respond with orders
			res.writeHead(200);
			res.end(
				JSON.stringify({
					slot,
					oracles,
					orders,
				})
			);
		} catch (e) {
			next(e);
		}
	});

	app.get('/orders/json', handleResponseTime, async (_req, res, next) => {
		try {
			// object with userAccount key and orders object serialized
			const slot = bulkAccountLoader.mostRecentSlot;
			const orders: Array<any> = [];
			const oracles: Array<any> = [];
			for (const market of driftClient.getPerpMarketAccounts()) {
				const oracle = driftClient.getOracleDataForPerpMarket(
					market.marketIndex
				);
				const oracleHuman = {
					marketIndex: market.marketIndex,
					price: oracle.price.toString(),
					slot: oracle.slot.toString(),
					confidence: oracle.confidence.toString(),
					hasSufficientNumberOfDataPoints:
						oracle.hasSufficientNumberOfDataPoints,
				};
				if (oracle.twap) {
					oracleHuman['twap'] = oracle.twap.toString();
				}
				if (oracle.twapConfidence) {
					oracleHuman['twapConfidence'] = oracle.twapConfidence.toString();
				}
				oracles.push(oracleHuman);
			}
			for (const user of userMap.values()) {
				const userAccount = user.getUserAccount();

				for (const order of userAccount.orders) {
					if (isVariant(order.status, 'init')) {
						continue;
					}

					const orderHuman = {
						status: getVariant(order.status),
						orderType: getVariant(order.orderType),
						marketType: getVariant(order.marketType),
						slot: order.slot.toString(),
						orderId: order.orderId,
						userOrderId: order.userOrderId,
						marketIndex: order.marketIndex,
						price: order.price.toString(),
						baseAssetAmount: order.baseAssetAmount.toString(),
						baseAssetAmountFilled: order.baseAssetAmountFilled.toString(),
						quoteAssetAmountFilled: order.quoteAssetAmountFilled.toString(),
						direction: getVariant(order.direction),
						reduceOnly: order.reduceOnly,
						triggerPrice: order.triggerPrice.toString(),
						triggerCondition: getVariant(order.triggerCondition),
						existingPositionDirection: getVariant(
							order.existingPositionDirection
						),
						postOnly: order.postOnly,
						immediateOrCancel: order.immediateOrCancel,
						oraclePriceOffset: order.oraclePriceOffset,
						auctionDuration: order.auctionDuration,
						auctionStartPrice: order.auctionStartPrice.toString(),
						auctionEndPrice: order.auctionEndPrice.toString(),
						maxTs: order.maxTs.toString(),
					};
					if (order.quoteAssetAmount) {
						orderHuman['quoteAssetAmount'] = order.quoteAssetAmount.toString();
					}

					orders.push({
						user: user.getUserAccountPublicKey().toBase58(),
						order: orderHuman,
					});
				}
			}

			// respond with orders
			res.writeHead(200);
			res.end(
				JSON.stringify({
					slot,
					oracles,
					orders,
				})
			);
		} catch (err) {
			next(err);
		}
	});

	app.get('/orders/idl', handleResponseTime, async (_req, res, next) => {
		try {
			const dlobOrders: DLOBOrders = [];

			for (const user of userMap.values()) {
				const userAccount = user.getUserAccount();

				for (const order of userAccount.orders) {
					if (isVariant(order.status, 'init')) {
						continue;
					}

					dlobOrders.push({
						user: user.getUserAccountPublicKey(),
						order,
					} as DLOBOrder);
				}
			}

			res.writeHead(200);
			res.end(dlobCoder.encode(dlobOrders));
		} catch (err) {
			next(err);
		}
	});

	app.get('/orders/idlWithSlot', handleResponseTime, async (req, res, next) => {
		try {
			const { marketName, marketIndex, marketType } = req.query;
			const { normedMarketType, normedMarketIndex, error } = validateDlobQuery(
				marketType as string,
				marketIndex as string,
				marketName as string
			);
			const useFilter =
				marketName !== undefined ||
				marketIndex !== undefined ||
				marketType !== undefined;

			if (useFilter) {
				if (
					error ||
					normedMarketType === undefined ||
					normedMarketIndex === undefined
				) {
					res.status(400).send(error);
					return;
				}
			}

			const dlobOrders: DLOBOrders = [];

			for (const user of userMap.values()) {
				const userAccount = user.getUserAccount();

				for (const order of userAccount.orders) {
					if (isVariant(order.status, 'init')) {
						continue;
					}

					if (useFilter) {
						if (
							getVariant(order.marketType) !== getVariant(normedMarketType) ||
							order.marketIndex !== normedMarketIndex
						) {
							continue;
						}
					}

					dlobOrders.push({
						user: user.getUserAccountPublicKey(),
						order,
					} as DLOBOrder);
				}
			}

			res.end(
				JSON.stringify({
					slot: bulkAccountLoader.mostRecentSlot,
					data: dlobCoder.encode(dlobOrders).toString('base64'),
				})
			);
		} catch (err) {
			next(err);
		}
	});

	const validateDlobQuery = (
		marketType?: string,
		marketIndex?: string,
		marketName?: string
	): {
		normedMarketType?: MarketType;
		normedMarketIndex?: number;
		error?: string;
	} => {
		let normedMarketType: MarketType = undefined;
		let normedMarketIndex: number = undefined;
		let normedMarketName: string = undefined;
		if (marketName === undefined) {
			if (marketIndex === undefined || marketType === undefined) {
				return {
					error:
						'Bad Request: (marketName) or (marketIndex and marketType) must be supplied',
				};
			}

			// validate marketType
			switch ((marketType as string).toLowerCase()) {
				case 'spot': {
					normedMarketType = MarketType.SPOT;
					normedMarketIndex = parseInt(marketIndex as string);
					const spotMarketIndicies = SpotMarkets[driftEnv].map(
						(mkt) => mkt.marketIndex
					);
					if (!spotMarketIndicies.includes(normedMarketIndex)) {
						return {
							error: 'Bad Request: invalid marketIndex',
						};
					}
					break;
				}
				case 'perp': {
					normedMarketType = MarketType.PERP;
					normedMarketIndex = parseInt(marketIndex as string);
					const perpMarketIndicies = PerpMarkets[driftEnv].map(
						(mkt) => mkt.marketIndex
					);
					if (!perpMarketIndicies.includes(normedMarketIndex)) {
						return {
							error: 'Bad Request: invalid marketIndex',
						};
					}
					break;
				}
				default:
					return {
						error: 'Bad Request: marketType must be either "spot" or "perp"',
					};
			}
		} else {
			// validate marketName
			normedMarketName = (marketName as string).toUpperCase();
			const derivedMarketInfo =
				driftClient.getMarketIndexAndType(normedMarketName);
			if (!derivedMarketInfo) {
				return {
					error: 'Bad Request: unrecognized marketName',
				};
			}
			normedMarketType = derivedMarketInfo.marketType;
			normedMarketIndex = derivedMarketInfo.marketIndex;
		}

		return {
			normedMarketType,
			normedMarketIndex,
		};
	};

	app.get('/topMakers', handleResponseTime, async (req, res, next) => {
		try {
			const {
				marketName,
				marketIndex,
				marketType,
				side, // bid or ask
				limit, // number of unique makers to return, if undefined will return all
			} = req.query;

			const { normedMarketType, normedMarketIndex, error } = validateDlobQuery(
				marketType as string,
				marketIndex as string,
				marketName as string
			);
			if (error) {
				res.status(400).send(error);
				return;
			}

			if (side !== 'bid' && side !== 'ask') {
				res.status(400).send('Bad Request: side must be either bid or ask');
				return;
			}
			const normedSide = (side as string).toLowerCase();
			const oracle = driftClient.getOracleDataForPerpMarket(normedMarketIndex);

			let normedLimit = undefined;
			if (limit) {
				if (isNaN(parseInt(limit as string))) {
					res
						.status(400)
						.send('Bad Request: limit must be a number if supplied');
					return;
				}
				normedLimit = parseInt(limit as string);
			}

			const topMakers: Set<string> = new Set();
			let foundMakers = 0;
			const findMakers = (sideGenerator: Generator<DLOBNode>) => {
				for (const side of sideGenerator) {
					if (limit && foundMakers >= normedLimit) {
						break;
					}
					if (side.userAccount) {
						const maker = side.userAccount.toBase58();
						if (topMakers.has(maker)) {
							continue;
						} else {
							topMakers.add(side.userAccount.toBase58());
							foundMakers++;
						}
					} else {
						continue;
					}
				}
			};

			if (normedSide === 'bid') {
				findMakers(
					dlobSubscriber
						.getDLOB()
						.getRestingLimitBids(
							normedMarketIndex,
							slotSubscriber.getSlot(),
							normedMarketType,
							oracle
						)
				);
			} else {
				findMakers(
					dlobSubscriber
						.getDLOB()
						.getRestingLimitAsks(
							normedMarketIndex,
							slotSubscriber.getSlot(),
							normedMarketType,
							oracle
						)
				);
			}

			res.writeHead(200);
			res.end(JSON.stringify([...topMakers]));
		} catch (err) {
			next(err);
		}
	});

	app.get('/l2', handleResponseTime, async (req, res, next) => {
		try {
			const {
				marketName,
				marketIndex,
				marketType,
				depth,
				includeVamm,
				includePhoenix,
				includeSerum,
			} = req.query;

			const { normedMarketType, normedMarketIndex, error } = validateDlobQuery(
				marketType as string,
				marketIndex as string,
				marketName as string
			);
			if (error) {
				res.status(400).send(error);
				return;
			}

			const isSpot = isVariant(normedMarketType, 'spot');

			const l2 = await dlobSubscriber.getL2({
				marketIndex: normedMarketIndex,
				marketType: normedMarketType,
				depth: depth ? parseInt(depth as string) : 10,
				includeVamm: `${includeVamm}`.toLowerCase() === 'true',
				fallbackL2Generators: isSpot
					? [
							`${includePhoenix}`.toLowerCase() === 'true' &&
								MARKET_SUBSCRIBERS[normedMarketIndex].phoenix,
							`${includeSerum}`.toLowerCase() === 'true' &&
								MARKET_SUBSCRIBERS[normedMarketIndex].serum,
					  ].filter((a) => !!a)
					: [],
			});

			for (const key of Object.keys(l2)) {
				for (const idx in l2[key]) {
					const level = l2[key][idx];
					const sources = level['sources'];
					for (const sourceKey of Object.keys(sources)) {
						sources[sourceKey] = sources[sourceKey].toString();
					}
					l2[key][idx] = {
						price: level.price.toString(),
						size: level.size.toString(),
						sources,
					};
				}
			}

			res.writeHead(200);
			res.end(JSON.stringify(l2));
		} catch (err) {
			next(err);
		}
	});

	app.get('/l3', handleResponseTime, async (req, res, next) => {
		try {
			const { marketName, marketIndex, marketType } = req.query;

			const { normedMarketType, normedMarketIndex, error } = validateDlobQuery(
				marketType as string,
				marketIndex as string,
				marketName as string
			);
			if (error) {
				res.status(400).send(error);
				return;
			}

			const l3 = dlobSubscriber.getL3({
				marketIndex: normedMarketIndex,
				marketType: normedMarketType,
			});

			for (const key of Object.keys(l3)) {
				for (const idx in l3[key]) {
					const level = l3[key][idx];
					l3[key][idx] = {
						...level,
						price: level.price.toString(),
						size: level.size.toString(),
					};
				}
			}

			res.writeHead(200);
			res.end(JSON.stringify(l3));
		} catch (err) {
			next(err);
		}
	});

	app.use(errorHandler);
	app.listen(serverPort, () => {
		logger.info(`DLOB server listening on port http://localhost:${serverPort}`);
	});
};

async function recursiveTryCatch(f: () => void) {
	try {
		await f();
	} catch (e) {
		console.error(e);
		await sleep(15000);
		await recursiveTryCatch(f);
	}
}

recursiveTryCatch(() => main());
