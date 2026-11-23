import { createBridge } from './service';
import { createDoPort, storefrontUrlFor } from './do-port';
import { suiteBuyerKeySecret } from '../config';
import logger from '../../logger';
import { buyerProofRequired } from './proof-policy';

/** The production bridge: DO port + storefront origin. Built per call (cheap, stateless). */
export const waBridge = () =>
  createBridge({
    port: createDoPort(),
    storefrontUrl: storefrontUrlFor,
    buyerKeySecret: suiteBuyerKeySecret,
    requireBuyerProof: () => buyerProofRequired(process.env.WA_BRIDGE_REQUIRE_BUYER_PROOF),
    log: (msg, ctx) => logger.error({ storeId: ctx.storeId, err: ctx.err }, msg),
  });
