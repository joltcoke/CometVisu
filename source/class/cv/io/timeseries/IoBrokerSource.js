/*
 * Copyright (c) 2023, Christian Mayer and the CometVisu contributors.
 *
 * This program is free software; you can redistribute it and/or modify it
 * under the terms of the GNU General Public License as published by the Free
 * Software Foundation; either version 3 of the License, or (at your option)
 * any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT
 * ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
 * FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
 * more details.
 *
 * You should have received a copy of the GNU General Public License along
 * with this program; if not, write to the Free Software Foundation, Inc.,
 * 59 Temple Place - Suite 330, Boston, MA  02111-1307, USA
 *
 */

/**
 * Time series source for the ioBroker backend. In contrast to the other sources the
 * data is not fetched from an URL, it is requested over the already established backend
 * connection, therefore the builtin fetching is disabled and fetchData() is used.
 *
 * The resource url is <code>iobroker://&lt;state.id&gt;</code>, the backend connection to
 * use can be named in front of it: <code>iobroker://&lt;backend&gt;@&lt;state.id&gt;</code>.
 */
qx.Class.define('cv.io.timeseries.IoBrokerSource', {
  extend: cv.io.timeseries.AbstractTimeSeriesSource,

  /*
  ***********************************************
    STATICS
  ***********************************************
  */
  statics: {
    /**
     * Maps the consolidationFunction values the diagrams use to the aggregate values
     * of the ioBroker history adapters.
     */
    AGGREGATIONS: {
      AVERAGE: 'average',
      MEAN: 'average',
      MIN: 'min',
      MAX: 'max',
      TOTAL: 'total',
      SUM: 'total',
      COUNT: 'count',
      INTEGRAL: 'integral',
      MINMAX: 'minmax',
      NONE: 'none'
    }
  },

  /*
  ***********************************************
    MEMBERS
  ***********************************************
  */
  members: {
    _historyOptions: null,

    /**
     * Options for the next getHistory requests, e.g. aggregate and step. They are merged
     * over the parameters of the resource url.
     * @param options {Map?}
     */
    setHistoryOptions(options) {
      this._historyOptions = options;
    },

    /**
     * Translates a consolidationFunction into the aggregate value of the ioBroker history
     * adapters. Values that are already ioBroker names are passed through.
     * @param cFunc {String}
     * @return {String|undefined}
     */
    _getAggregate(cFunc) {
      if (!cFunc) {
        return undefined;
      }

      const known = cv.io.timeseries.IoBrokerSource.AGGREGATIONS;
      const upper = ('' + cFunc).toUpperCase();
      if (Object.prototype.hasOwnProperty.call(known, upper)) {
        return known[upper];
      }

      const lower = ('' + cFunc).toLowerCase();
      for (const name in known) {
        if (known[name] === lower) {
          return lower;
        }
      }

      this.error(`ioBroker has no aggregation for consolidationFunction "${cFunc}", using "average"`);

      return 'average';
    },

    /**
     * The options for a getHistory request, built from the resource url parameters and
     * the options set by the chart.
     * @return {Map}
     */
    _getHistoryOptions() {
      const resourceConf = this.getConfig();
      const options = Object.assign({}, resourceConf ? resourceConf.params : {}, this._historyOptions || {});

      if (options.aggregate) {
        options.aggregate = this._getAggregate(options.aggregate);
      }
      if (options.step) {
        const step = parseInt(options.step, 10);
        if (step > 0) {
          options.step = step;
        } else {
          delete options.step;
        }
      }
      if (options.aggregate === 'none') {
        // "none" has to be sent, leaving it out lets ioBroker fall back to its own default.
        // Without aggregation there are no intervals, so asking for a step would only
        // produce empty interval markers instead of the stored values.
        delete options.step;
      }

      return options;
    },

    /**
     * The data is requested over the backend connection, this disables the builtin
     * fetching of the chart components and makes them call fetchData() instead.
     * @param start {String} start time
     * @param end {String?} end time
     * @param series {String?} series name
     * @param offset {Number?} series offset
     * @return {{fetch: boolean}}
     */
    getRequestConfig(start, end, series, offset) {
      return {
        fetch: false,
        url: '',
        options: {},
        proxy: false
      };
    },

    /**
     * The connection this source reads from. It is the one named in the resource url,
     * the default backend connection when none is named.
     * @return {cv.io.IClient?}
     */
    getClient() {
      const resourceConf = this.getConfig();
      const client = cv.io.BackendConnections.getClient(resourceConf ? resourceConf.authority : undefined);

      if (!client || client.getType() !== 'iobroker') {
        return null;
      }

      return client;
    },

    /**
     * The state id this source reads. It is percent encoded in the resource url, as it
     * may contain characters that are structural there ("#", "?", "/").
     * @return {String}
     */
    getStateId() {
      const resourceConf = this.getConfig();
      if (!resourceConf) {
        return '';
      }

      try {
        return decodeURIComponent(resourceConf.name);
      } catch (e) {
        // not encoded at all, use it as it is
        return resourceConf.name;
      }
    },

    /**
     * Resolves once the client is connected. The history can only be requested over an
     * established connection, and the charts usually ask for their data while the backend
     * connection is still being set up.
     * @param client {cv.io.IClient}
     * @param timeout {Number} how long to wait in milliseconds
     * @return {Promise}
     */
    _whenConnected(client, timeout = 30000) {
      if (client.isConnected()) {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        let listenerId = null;
        let timer = null;

        let activeListenerId = null;
        const app = qx.core.Init.getApplication();

        const done = error => {
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          client.removeListenerById(listenerId);
          if (activeListenerId !== null && app) {
            app.removeListenerById(activeListenerId);
            activeListenerId = null;
          }
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };

        // While the application is inactive the backend connections are terminated on
        // purpose and only re-established when it becomes active again. Counting down a
        // timeout during that time would fail a request nobody can see anyway, so the
        // timer only runs while the application is active.
        const startTimer = () => {
          if (timer || (app && !app.isActive())) {
            return;
          }
          timer = setTimeout(() => {
            done(new Error(`no connection to the ioBroker backend after ${timeout / 1000}s`));
          }, timeout);
        };

        if (app) {
          activeListenerId = app.addListener('changeActive', ev => {
            if (ev.getData()) {
              startTimer();
            } else if (timer) {
              clearTimeout(timer);
              timer = null;
            }
          });
        }

        listenerId = client.addListener('changeConnected', ev => {
          if (ev.getData()) {
            done();
          }
        });

        startTimer();
      });
    },

    /**
     * Request the recorded values from the ioBroker backend.
     * @param start {String} start time, e.g. "end-3day" or a unix timestamp
     * @param end {String?} end time, "now" when not set
     * @param series {String?} series name, unused
     * @param offset {Number?} series offset, unused
     * @return {Promise<Array>}
     */
    async fetchData(start, end, series, offset) {
      const resourceConf = this.getConfig();
      if (!resourceConf) {
        return [];
      }

      const client = this.getClient();
      if (!client) {
        const name = resourceConf.authority;
        this.error(
          `${name ? `backend connection "${name}"` : 'the default backend connection'} is no ioBroker ` +
            `connection, no history data for "${this.getStateId()}"`
        );

        return [];
      }

      // the charts request their data while the backend connection may still be opening
      await this._whenConnected(client);

      const timeRange = this.getTimeRange(start, end);
      if (!timeRange.start) {
        this.error(`cannot determine a time range from "${start}", no history data for "${this.getStateId()}"`);

        return [];
      }

      const options = this._getHistoryOptions();
      try {
        return await client.getHistory(this.getStateId(), timeRange.start, timeRange.end, options);
      } catch (e) {
        if (client.isConnected()) {
          // the request itself failed, retrying would not change that
          throw e;
        }

        // the connection dropped while the request was in flight, it gets re-established
        // automatically, so wait for it and give the request one more try
        this.debug('connection lost during the history request, retrying after the reconnect');
        await this._whenConnected(client);

        return client.getHistory(this.getStateId(), timeRange.start, timeRange.end, options);
      }
    },

    /**
     * Converts the ioBroker history entries into the [timestamp, value] pairs the charts use.
     * @param data {Array} entries with a "ts" and a "val"
     * @return {Array}
     */
    processResponse(data) {
      if (!Array.isArray(data)) {
        this.error('invalid history data response');

        return [];
      }

      return data.filter(entry => entry && entry.val !== null && entry.val !== undefined).map(entry => [entry.ts, entry.val]);
    }
  }
});
