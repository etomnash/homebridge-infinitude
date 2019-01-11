const { pluginName, platformName } = require('./constants');
const Joi = require('joi');

const configSchema = require('./configSchema');
const InfinitudeClient = require('./InfinitudeClient');

let Characteristic, Thermostat;

module.exports = class InfinitudePlatform {
  constructor(log, config, api) {
    if (!config) {
      log.info('Plugin not configured.');
      return;
    }

    const result = Joi.validate(config, configSchema);
    if (result.error) {
      log.error('Invalid config.', result.error.message);
      return;
    }
    log.info(result);

    Characteristic = api.hap.Characteristic;
    Thermostat = api.hap.Service.Thermostat;

    this.log = log;
    this.api = api;
    this.accessories = {};
    this.zoneIds = {};
    this.zoneNames = {};
    this.client = new InfinitudeClient(config['url'], this.log);

    this.api.on('didFinishLaunching', this.didFinishLaunching.bind(this));
  }

  configureAccessory(accessory) {
    this.accessories[accessory.UUID] = accessory;
  }

  async didFinishLaunching() {
    this.initializeThermostats();
    for (const uuid in this.accessories) {
      this.configureThermostatAccessory(this.accessories[uuid]);
    }
  }

  async initializeThermostats() {
    const status = await this.client.getStatus();

    const enabledZones = status['zones']['zone'].filter(zone => zone['enabled'] === 'on');

    for (const zone of enabledZones) {
      const zoneId = zone['id'];
      const tUuid = this.api.hap.uuid.generate(zoneId);
      this.accessories[tUuid] = this.accessories[tUuid] || this.createThermostatAccessory(zone, tUuid);
      this.zoneIds[tUuid] = zoneId;
    }

    this.api.emit('didFinishInit');
  }

  createThermostatAccessory(zone, uuid) {
    const thermostatName = `${zone['name']} Thermostat`;
    const newAccessory = new this.api.platformAccessory(thermostatName, uuid);
    newAccessory.addService(Thermostat, thermostatName);
    this.api.registerPlatformAccessories(pluginName, platformName, [newAccessory]);
    this.configureThermostatAccessory(newAccessory);
    this.zoneNames[uuid] = thermostatName;
    return newAccessory;
  }

  configureThermostatAccessory(accessory) {
    const thermostatService = accessory.getService(Thermostat);
    const zoneName = this.getZoneName(accessory);

    thermostatService.setCharacteristic(
      Characteristic.TemperatureDisplayUnits,
      Characteristic.TemperatureDisplayUnits.FAHRENHEIT
    );

    thermostatService.getCharacteristic(Characteristic.CurrentTemperature).on(
      'get',
      function(callback) {
        this.getCurrentTemperature(accessory).then(function(currentTemperature) {
          callback(null, currentTemperature);
        });
      }.bind(this)
    );

    thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).on(
      'get',
      function(callback) {
        this.getCurrentHeatingCoolingState(accessory).then(function(state) {
          callback(null, state);
        });
      }.bind(this)
    );

    thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .on(
        'get',
        function(callback) {
          this.getTargetHeatingCoolingState(accessory).then(function(state) {
            callback(null, state);
          });
        }.bind(this)
      )
      .on(
        'set',
        function(targetHeatingCoolingState, callback) {
          switch (targetHeatingCoolingState) {
            case Characteristic.TargetHeatingCoolingState.OFF:
              return this.client.setActivity(this.getZoneId(accessory), 'away', callback);
            case Characteristic.TargetHeatingCoolingState.AUTO:
              return this.client.setActivity(this.getZoneId(accessory), 'home', callback);
            default:
              this.log.warn(`Unsupported state ${targetHeatingCoolingState} for zone ${zoneName}`);
              callback('Not supported');
              break;
          }
        }.bind(this)
      );

    thermostatService
      .getCharacteristic(Characteristic.HeatingThresholdTemperature)
      .on(
        'get',
        function(callback) {
          this.getTargetTemperatures(accessory, 'home').then(function(targetTemperatures) {
            callback(null, targetTemperatures.htsp);
          });
        }.bind(this)
      )
      .on(
        'set',
        function(heatingThresholdTemperature, callback) {
          this.log.warn(`Unsupported heatingThresholdTemperature ${heatingThresholdTemperature} for zone ${zoneName}`);
          callback('Not supported');
        }.bind(this)
      );

    thermostatService
      .getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .on(
        'get',
        function(callback) {
          this.getTargetTemperatures(accessory, 'home').then(function(targetTemperatures) {
            callback(null, targetTemperatures.clsp);
          });
        }.bind(this)
      )
      .on(
        'set',
        function(coolingThresholdTemperature, callback) {
          this.log.warn(`Unsupported coolingThresholdTemperature ${coolingThresholdTemperature} for zone ${zoneName}`);
          callback('Not supported');
        }.bind(this)
      );

    thermostatService.getCharacteristic(Characteristic.CurrentRelativeHumidity).on(
      'get',
      function(callback) {
        this.getCurrentRelativeHumidity(accessory).then(function(humidity) {
          callback(null, humidity);
        });
      }.bind(this)
    );

    thermostatService.getCharacteristic(Characteristic.TargetTemperature).on(
      'set',
      function(targetTemperature, callback) {
        this.log.warn(`Unsupported targetTemperature ${targetTemperature} for zone ${zoneName}`);
        callback('Not supported');
      }.bind(this)
    );
  }

  getValue(accessory, characteristic) {
    return new Promise((resolve, reject) => {
      accessory
        .getService(Thermostat)
        .getCharacteristic(characteristic)
        .getValue(function(error, currentTemperature) {
          if (error) {
            reject(error);
          } else {
            resolve(currentTemperature);
          }
        });
    });
  }

  setValue(accessory, characteristic, newValue) {
    return new Promise((resolve, reject) => {
      accessory
        .getService(Thermostat)
        .getCharacteristic(characteristic)
        .setValue(newValue, function(error) {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
    });
  }

  static fahrenheitToCelsius(temperature) {
    return (temperature - 32) / 1.8;
  }

  getZoneName(accessory) {
    return this.zoneNames[accessory.UUID];
  }

  getZoneId(accessory) {
    return this.zoneIds[accessory.UUID];
  }

  getCurrentTemperature(accessory, property = 'rt') {
    return this.getZoneStatus(accessory).then(function(zoneStatus) {
      return InfinitudePlatform.convertInfinitudeTemperature(zoneStatus[property]);
    });
  }

  getTargetTemperatures(accessory, acvitityId) {
    return this.getZoneTarget(this.getZoneId(accessory)).then(function(zoneTarget) {
      const activityTarget = zoneTarget['activities'][0]['activity'].find(activity => activity['id'] == acvitityId);
      return {
        htsp: InfinitudePlatform.convertInfinitudeTemperature(activityTarget.htsp[0]),
        clsp: InfinitudePlatform.convertInfinitudeTemperature(activityTarget.clsp[0])
      };
    });
  }

  getCurrentHeatingCoolingState(accessory) {
    return this.getZoneStatus(accessory).then(function(status) {
      switch (status['zoneconditioning']) {
        case 'idle':
          return Characteristic.CurrentHeatingCoolingState.OFF;
        case 'active_heat':
          return Characteristic.CurrentHeatingCoolingState.HEAT;
        default:
          return Characteristic.CurrentHeatingCoolingState.COOL;
      }
    });
  }

  getTargetHeatingCoolingState(accessory) {
    return this.getTargetActivityId(accessory).then(
      function(targetActivityId) {
        switch (targetActivityId) {
          case 'away':
            return Characteristic.TargetHeatingCoolingState.OFF;
          case 'home':
            return Characteristic.TargetHeatingCoolingState.AUTO;
          default:
            this.log.warn(`Unexpected activity ${targetActivityId} for zone ${this.getZoneId(accessory)}`);
            return Characteristic.TargetHeatingCoolingState.OFF;
        }
      }.bind(this)
    );
  }

  getCurrentRelativeHumidity(accessory) {
    return this.getZoneStatus(accessory).then(function(status) {
      return parseFloat(status['rh']);
    });
  }

  getTargetActivityId(accessory) {
    return this.getZoneTarget(this.getZoneId(accessory)).then(function(zoneTarget) {
      return zoneTarget['holdActivity'][0];
    });
  }

  getZoneTarget(zoneId) {
    return this.client.getSystems().then(function(systems) {
      return systems['system'][0]['config'][0]['zones'][0]['zone'].find(zone => zone['id'] === zoneId);
    });
  }

  getZoneStatus(accessory) {
    return this.client.getStatus().then(
      function(status) {
        return status.zones.zone.find(zone => zone['id'] === this.getZoneId(accessory));
      }.bind(this)
    );
  }

  static convertInfinitudeTemperature(temperature) {
    return this.fahrenheitToCelsius(temperature);
  }
};
