'use strict';

const createZoompag = require('./zoompag');
const createVeltrax = require('./veltrax');
const createRapdyn = require('./rapdyn');
const createSafepix = require('./safepix');

module.exports = function createProviders({ axios, logger } = {}) {
  return {
    zoompag: createZoompag({ axios, logger }),
    veltrax: createVeltrax({ axios, logger }),
    rapdyn: createRapdyn({ axios, logger }),
    safepix: createSafepix({ axios, logger }),
  };
};
