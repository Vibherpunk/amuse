import { Router, type IRouter } from "express";
import healthRouter from "./health";
import testingRouter from "./testing";
import coreRouter from "./core";
import contentRouter from "./content";
import discoverRouter from "./discover";
import docsRouter from "./docs";

const router: IRouter = Router();

router.use(healthRouter);
// Test-only hooks for the end-to-end suite; mounted only when AMUSE_E2E=1 outside production.
if (process.env.AMUSE_E2E === "1" && process.env.NODE_ENV !== "production") router.use(testingRouter);
router.use(discoverRouter);
router.use(coreRouter);
router.use(contentRouter);
router.use(docsRouter);

export default router;
