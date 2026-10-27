// -----------------------------------------------------------------------------
// Entry point: SDK wiring only (src/handlers.js registers every handler BEFORE
// connect(), and delegates to the KomfoventApp of src/app.js).
//
// Environment variables provided by the Gladys supervisor, read by the SDK:
// GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { KomfoventApp } from './src/app.js';
import { registerHandlers } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new KomfoventApp({ gladys });

registerHandlers(gladys, app, logger);
gladys.handleShutdown(() => app.shutdown());

logger.info('Starting the Komfovent integration...');
// A stop that may not have landed before a restart is sent again from /data
// first, without waiting for Gladys nor the configuration.
app
  .boot()
  .catch((err) => logger.warn(`Komfovent: boot: ${err.message}`))
  .then(() => gladys.connect())
  .catch((err) => {
    logger.error('Initial connection failed', err);
    process.exit(1);
  });
