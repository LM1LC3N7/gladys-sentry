// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // --- Discovery and device lifecycle ------------------------------------------
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  // An update (renamed, room changed...) makes the SDK forget the values: sent again.
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));

  // --- Configuration screen ------------------------------------------------------
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  // Saved by the user: a token refused earlier is tried again.
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated: restarting');
    return app.start(config, { force: true });
  });

  // --- Connection lifecycle: (re)start on every connection (everything is
  // published again; /data keeps the time of the last round, so a reading is
  // never sooner than the interval), stop while Gladys is away. The
  // configuration unreadable (Gladys still starting): asked again in 30 s,
  // never left without a timer (cleared by a disconnection).
  const startFromGladys = async () => {
    try {
      await app.start(await gladys.getConfig());
    } catch (err) {
      logger?.error(`Start failed: ${app.describe(err)}`);
      app.retryStart(startFromGladys);
    }
  };
  gladys.on('connected', startFromGladys);
  gladys.on('disconnected', () => app.stop());
}
