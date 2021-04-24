import { Logger, PlatformConfig } from 'homebridge';
import { TeslafiAPI } from './api';
import { ITeslaCar } from './ITesla';
import { EventEmitter } from 'events';
import { throws } from 'assert';

export class TeslaCar implements ITeslaCar {
  public em: EventEmitter;
  private intervallRefresh: any;
  public skipUpdate = false; // If an API call is ongoing, ignoree event in order to not reset accessory status.

  public rangeUnit: string;
  private milesToKm = 1.609344;
  public tempUnit: string;
  private teslafiapi: TeslafiAPI;

  private teslafiRefreshTimeout: number;
  private wakeupTimeout: number;

  public display_name = 'Tesla';
  public state = 'asleep';
  public sentry_mode = false;

  public software = {
    current: '2003.7.1', // Default value until we have the actual. This is Tesla founding date ;)
    new: '2003.7.1',
    status: '',
  };

  // Current location
  public location = 'unknown';

  public chargePortOpen = false;

  public doorLockOpen = false;

  public battery = {
    charging: false,
    connected: false,
    level: 50,
    usableLevel: 50,
    heater: false,
    range: 0,
    estimatedRange: 0,
    chargeLimit: 90,
  };

  public climateControl = {
    canHeat: true, // not_enough_power_to_heat
    isClimateOn: false, // is_auto_conditioning_on
    insideTemp: 20, // inside_temp
    outsideTemp: 20, // outside_temp
    maxAvailTemp: 28, // max_avail_temp
    minAvailTemp: 15, // min_avail_temp
    tempSetting: 20, // driver_temp_setting  - also passenger_temp_setting, use?
  };

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig
  ) {
    this.em = new EventEmitter();

    this.rangeUnit = <string>config['rangeUnit'];
    this.tempUnit = <string>config['tempUnit'];

    config['teslafiRefreshTimeout'] &&
    !isNaN(<number>config['teslafiRefreshTimeout'])
      ? (this.teslafiRefreshTimeout =
          <number>config['teslafiRefreshTimeout'] * 1000)
      : (this.teslafiRefreshTimeout = 60 * 1000);

    config['wakeupTimeout'] && !isNaN(<number>config['wakeupTimeout'])
      ? (this.wakeupTimeout = <number>config['wakeupTimeout'])
      : (this.wakeupTimeout = 15);

    this.teslafiapi = new TeslafiAPI(log, config);
    this.refresh();

    this.intervallRefresh = setInterval(() => {
      this.refresh();
    }, this.teslafiRefreshTimeout);
  }

  public async refresh() {
    const result = await this.teslafiapi.action('', '');

    // Is car online?
    result.state ? (this.state = result.state) : (this.state = 'asleep');

    if (
      this.state === 'online' &&
      !(result.Notes && result.Notes === 'Trying To Sleep')
    ) {
      // When asleep, teslafi returns null for most values, so keep what we have
      // Also when Trying to sleep, it returns online, but values ar null!

      // Climate is_climate_on (not is_auto_conditioning_on)
      result.is_climate_on && result.is_climate_on === '1'
        ? (this.climateControl.isClimateOn = true)
        : (this.climateControl.isClimateOn = false);

      result.not_enough_power_to_heat
        ? (this.climateControl.canHeat = false)
        : (this.climateControl.canHeat = true); // has a null value if it can heat? To be verified

      if (result.inside_temp) {
        this.climateControl.insideTemp = parseFloat(result.inside_temp);
      }

      if (result.outside_temp) {
        this.climateControl.outsideTemp = parseFloat(result.outside_temp);
      }

      if (result.max_avail_temp) {
        this.climateControl.maxAvailTemp = parseFloat(result.max_avail_temp);
      }

      if (result.min_avail_temp) {
        this.climateControl.minAvailTemp = parseFloat(result.min_avail_temp);
      }

      if (result.driver_temp_setting) {
        this.climateControl.tempSetting = parseFloat(
          result.driver_temp_setting
        );
      }

      // Sentry mode
      if(result.sentry_mode && result.sentry_mode === '1') {
        this.sentry_mode = true
      } else if(result.sentry_mode && result.sentry_mode === '0') {
        this.sentry_mode = false
      } else {
        this.log.debug('Sentry mode returned unexpected result.', result.sentry_mode);
      } 

      // Battery & Charge
      if (result.battery_range) {
        let range = parseInt(result.battery_range);
        if (this.rangeUnit === 'km') {
          range = range * this.milesToKm;
        }
        this.battery.range = Math.round(range);
      }
      if (result.est_battery_range) {
        let range = parseInt(result.est_battery_range);
        if (this.rangeUnit === 'km') {
          range = range * this.milesToKm;
        }
        this.battery.estimatedRange = Math.round(range);
      }
      result.carState && result.carState === 'Charging'
        ? (this.battery.charging = true)
        : (this.battery.charging = false);

      // Charging cable connected, empty string false, connected returns an id of cable (non empty string)
      // There is something wrong with the parsing if empty, becomes <invalid>
      result.conn_charge_cable && result.conn_charge_cable !== '<invalid>'
        ? (this.battery.connected = true)
        : (this.battery.connected = false);

      if (result.battery_level && parseInt(result.battery_level)) {
        this.battery.level = parseInt(result.battery_level);
      }

      if (
        result.usable_battery_level &&
        parseInt(result.usable_battery_level)
      ) {
        this.battery.usableLevel = parseInt(result.usable_battery_level);
      }

      if(result.charge_limit_soc && parseInt(result.charge_limit_soc)) {
        this.battery.chargeLimit = parseInt(result.charge_limit_soc)
      }
      result.battery_heater_on && result.battery_heater_on === '1'
        ? (this.battery.heater = true)
        : (this.battery.heater = false);

      if (result.car_version) {
        this.software.current = result.car_version;
      }

      result.locked && result.locked !== '1'
        ? (this.doorLockOpen = true)
        : (this.doorLockOpen = false);
    }

    // These we check outside of being online
    // Use "charge_port_latch":"Disengaged" or "charge_port_latch":"Engaged" instead of charge_port_door_open: "1"
    // What we want is if we can Connect/disconnect cable. So for example if car is charging, show as locked even
    // if charge port is actually open. That way we can "unlock" and release charge cable.
    result.charge_port_latch && result.charge_port_latch === 'Disengaged'
      ? (this.chargePortOpen = true)
      : (this.chargePortOpen = false);

    result.location
      ? (this.location = result.location)
      : (this.location = 'unknown');

    result.newVersion
      ? (this.software.new = result.newVersion)
      : (this.software.new = '');

    result.newVersionStatus
      ? (this.software.status = result.newVersionStatus)
      : (this.software.status = '');

    // Finally emit event
    this.em.emit('teslafifetch');
    // If for some reason, the skip has not been reset, we do so to avoid it never updating. But only after we emitted event.
    // TODO: Evaluate if this has desired outcome.
    this.skipUpdate = false;
  }

  public async wakeUp() {
    this.skipUpdate = true;
    return await this.teslafiapi
      .action('wake_up', '')
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.state = 'online';

          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  public async sleep() {
    this.skipUpdate = true;
    return await this.teslafiapi
      .action('sleep', '')
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.state = 'asleep';
          this.notes = 'Trying To Sleep';
          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  public async toggleSentryMode(status) {
    this.skipUpdate = true;
    return await this.teslafiapi
      .action('set_sentry_mode', status)
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.sentry_mode = status;
          this.setCarAsOnline();
          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  public async setChargeLimit(value) {
    this.skipUpdate = true;
    return await this.teslafiapi
      .action('set_charge_limit', value)
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.battery.chargeLimit = value;
          this.setCarAsOnline();
          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  public async toggleCharging(status) {
    this.skipUpdate = true;
    let action = status ? 'charge_start' : 'charge_stop';
    return await this.teslafiapi
      .action(action, '')
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.battery.charging = status;
          this.setCarAsOnline();
          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  public async toggleChargePortOpen(status) {
    this.skipUpdate = true;
    let action = status ? 'charge_port_door_open' : 'charge_port_door_close';
    return await this.teslafiapi
      .action(action, '')
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.chargePortOpen = status;
          this.setCarAsOnline();
          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  public async toggleDoorLockOpen(status) {
    this.skipUpdate = true;
    let action = status ? 'door_unlock' : 'door_lock';
    return await this.teslafiapi
      .action(action, '')
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.doorLockOpen = status;
          this.setCarAsOnline();
          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  public async toggleClimateOn(status) {
    this.skipUpdate = true;
    let action = status ? 'auto_conditioning_start' : 'auto_conditioning_stop';

    return await this.teslafiapi
      .action(action, '')
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.climateControl.isClimateOn = status;
          this.setCarAsOnline();
          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  public async setClimateTemp(temp) {
    this.skipUpdate = true;
    return await this.teslafiapi
      .action('set_temps', temp)
      .then(async (response) => {
        if (response.response && response.response.result) {
          this.climateControl.tempSetting = temp;
          this.setCarAsOnline();
          return true;
        } else {
          // Not changing car state, we do not know the actual state, let polling find out.
          return false;
        }
      })
      .finally(() => {
        this.afterAPICall();
      });
  }

  private setCarAsOnline() {
    //Check if configure to wake the car when sending command, if so also set status to online
    // We do this since it can take some timee for TeslaFi API to update its online status.
    if (this.wakeupTimeout > 0) {
      this.state = 'online';
    }
  }

  private afterAPICall() {
    this.skipUpdate = false;
    // Restart intervall timer
    clearInterval(this.intervallRefresh);
    this.intervallRefresh = setInterval(() => {
      this.refresh();
    }, this.teslafiRefreshTimeout);

    // Emit event to update any changes, but wait 1s (just a hunch Homekit not happy if a change comes immediately)
    setTimeout(() => {
      this.em.emit('teslafifetch');
    }, 1000);
  }
}
