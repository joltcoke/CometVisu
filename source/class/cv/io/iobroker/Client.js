/* Client.js
 *
 * copyright (c) 2010-2023, Christian Mayer and the CometVisu contributers.
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
 */

/**
 * ioBroker client
 */
qx.Class.define('cv.io.iobroker.Client', {
  extend: cv.io.AbstractClient,
  implement: cv.io.IClient,

  /*
  ***********************************************
    CONSTRUCTOR
  ***********************************************
  */
  construct(type, backendUrl) {
    super();
    this.initialAddresses = [];
    this._type = type;
    this._backendUrl = new URL(backendUrl || document.URL.replace(/.*:\/\/([^\/:]*)(:[0-9]*)?\/.*/, 'ws://$1:8083/'));
    this.__subscribedAddresses = [];
    this.__pendingRequests = [];
    this.__credentials = { username: null, password: null };
  },

  /*
  ***********************************************
    MEMBERS
  ***********************************************
  */
  members: {
    _type: null,
    __subscribedAddresses: null,
    __nextMessageId: 0,
    __connection: null,
    __pendingRequests: null,
    __credentials: null,
    __pingTimer: null,
    __pureWebsocket: true,
    __reconnectTimer: null,
    __reconnectAttempt: 0,
    __terminated: false,

    /**
     * Returns the current backend configuration
     * @return {Map}
     */
    getBackend() {
      return {};
    },

    getType() {
      return this._type;
    },

    /**
     * Returns true, when the backend provides a special data provider for this kind of data
     * @param name {String}
     * @return {Boolean}
     */
    hasProvider(name) {
      return false;
    },

    /**
     * URL to the provided data
     * @param name
     * @return {String}
     */
    getProviderUrl(name) {
      return null;
    },

    /**
     * Mapping function to convert the data from the backend to a format the CometVisu data provider consumer can process.
     * @param name {String}
     */
    getProviderConvertFunction(name) {
      return null;
    },

    getProviderData: function (name, format) {
      return null;
    },

    /**
     * Set a subset of addresses the client should request initially (e.g. the ones one the start page).
     * This can be used to increase the init state loading speed by sending an initial request with a smaller
     * subset of addresses to the backend and send the rest later.
     * @param addresses {Array}
     */
    setInitialAddresses(addresses) {
      this.__subscribedAddresses = addresses;
    },

    __serverGetStates(addresses) {
      return this.__sendMessageResponse('getStates', addresses);
    },

    /**
     * Read the recorded history of a state. This needs one of the ioBroker history
     * adapters (history, sql, influxdb) to be enabled for that state.
     * @param address {String} state id
     * @param start {Date} beginning of the time range
     * @param end {Date} end of the time range
     * @param options {Map?} additional getHistory options, e.g. count, aggregate or step
     * @return {Promise<Array>} the recorded entries, each with a "ts" and a "val"
     */
    async getHistory(address, start, end, options) {
      if (!this.isConnected() || !this.__isSocketOpen()) {
        // fail fast before reaching a send() on a socket that is not OPEN; the diagram source
        // treats this as a transient disconnect and retries after the reconnect
        throw new Error('not connected to ' + this._backendUrl);
      }

      const response = await this.__sendMessageResponse(
        'getHistory',
        address,
        Object.assign(
          {
            start: start.getTime(),
            end: end.getTime(),
            count: 10000,
            ignoreNull: true
          },
          // no aggregate default here, it would override what the caller deliberately left out
          options || {}
        )
      );

      // the ioBroker socket api answers with the arguments of its (error, result) callback
      const [error, result] = response || [];
      if (error) {
        throw new Error('getHistory for ' + address + ' failed: ' + error);
      }

      return result || [];
    },

    __serverSetState(address, value) {
      this.__sendMessage('setState', address, value);
    },

    __serverSubscribeStates(addresses) {
      this.__sendMessage('subscribeStates', addresses);
    },

    async __subscribeStates() {
      if ((!this.isConnected()) || (!this.__subscribedAddresses.length)) {
        return;
      }

      await this.__subscribeAddresses(this.__subscribedAddresses);
    },

    /**
     * Subscribe to the given addresses and publish their current states. ioBrokers
     * subscribeStates adds to the already subscribed patterns and ignores duplicates,
     * so this can be called incrementally.
     * @param addresses {Array} addresses to subscribe to
     */
    async __subscribeAddresses(addresses) {
      this.__serverSubscribeStates(addresses);

      let response;
      try {
        response = await this.__serverGetStates(addresses);
      } catch (e) {
        this.error('getStates request failed:', e.message || e);
        return;
      }

      // the ioBroker socket api answers with the arguments of its (error, states) callback
      const [error, states] = response || [];
      if (error) {
        this.error('getStates failed:', error);
        return;
      }

      let newStates = {};

      for (let id in states) {
        if (states[id]) {
          newStates[id] = states[id].val;
        }
      }

      this.update(newStates);
    },

    /**
     * Whether the underlying socket exists and is ready to send. WebSocket.send() throws an
     * InvalidStateError when the socket is not OPEN (on Safari also while it is CLOSING or
     * CLOSED, not only CONNECTING), so every send has to be guarded by this.
     * @return {Boolean}
     */
    __isSocketOpen() {
      return !!this.__connection && this.__connection.readyState === window.WebSocket.OPEN;
    },

    __sendMessage(name, ...args) {
      if (!this.__isSocketOpen()) {
        // sending on a socket that is not OPEN would throw; drop the message instead, the
        // caller state (e.g. subscriptions) is re-established on the next '___ready___'
        this.debug('not sending "' + name + '", socket is not open');
        return;
      }
      if (this.__pureWebsocket) {
        this.__connection.send(JSON.stringify([3, this.__nextMessageId++, name, [...args]]));
      } else {
        this.__connection.send('42' + JSON.stringify([name, ...args, null]));
      }
    },

    __sendMessageResponse(name, ...args) {
      return new Promise((resolve, reject) => {
        if (!this.__isSocketOpen()) {
          // sending now would throw an InvalidStateError; reject with the same message the
          // connection guards use, so the caller can treat it as a transient disconnect
          reject(new Error('not connected to ' + this._backendUrl));
          return;
        }

        let request = {
          id: this.__nextMessageId++,
          resolve: resolve,
          reject: reject
        };

        this.__pendingRequests.push(request);

        if (this.__pureWebsocket) {
          this.__connection.send(JSON.stringify([3, request.id, name, [...args]]));
        } else {
          this.__connection.send('42' + request.id + JSON.stringify([name, ...args]));
        }
      });
    },

    __decodeMessage(msg) {
      if (this.__pureWebsocket) {
        return JSON.parse(msg);
      }

      const result = msg.match(/^(?<etype>\d)(?<stype>\d)?(?<id>\d+)?(?<payload>.*)/);

      switch (result.groups.etype) {
        case '0': /* OPEN */
          return [0, null, '___setup___', JSON.parse(result.groups.payload)];
        case '3': /* PONG */
          return [undefined];
        case '4': /* MESSAGE */
          switch (result.groups.stype) {
            case '0':
              return [0, 0, '___ready___'];
            case '2':
            {
              const [name, ...payload] = JSON.parse(result.groups.payload);

              return [0, null, name, payload];
            }
            case '3':
              return [3, Number(result.groups.id), null, JSON.parse(result.groups.payload)];
            default:
              this.debug('Unknown socket.io type:', result.groups.stype);
              return [undefined];
          }
        default:
          this.debug('Unknown engine.io type:', result.groups.etype);
          return [undefined];
      }
    },

    __initiateConnection(callback = null, context = null) {
      if (this.__connection) {
        // never leave a second socket behind, its close handler would reject the
        // pending requests of the new one
        this.__closeQuietly();
      }
      this.__terminated = false;

      /**
       * @param param
       */
      const onFailure = param => {
        this.setConnected(false);
        let n = cv.core.notifications.Router.getInstance();
        n.dispatchMessage(
          'cv.client.connection',
          {
            title: 'ioBroker: ' + qx.locale.Manager.tr('Connection error'),
            message: param.errorMessage + '<br/>\nCode: ' + param.errorCode,
            severity: 'urgent',
            unique: true,
            deletable: false
          },

          'popup'
        );
      };

      try {
        // build the structural parameters with URLSearchParams, keeping whatever the
        // backend url already carries
        const query = new window.URLSearchParams(this._backendUrl.search);
        let path = '';

        if (this.__pureWebsocket) {
          query.set('sid', Date.now());
          path += '/';
        } else {
          query.set('transport', 'websocket');
          path += '/socket.io/';
        }

        let queryString = query.toString();

        // Append user and pass url-encoded, so credentials containing any character
        // (& = # % + or whitespace) survive the query transport. The ioBroker ws
        // authentication gate (getQuery() in @iobroker/socket-classes passportSocket.js,
        // run during the upgrade) decodes each value with decodeURIComponent, so the
        // encoded credential is compared against its decoded, original value.
        const credentials = this.__credentials || {};
        if (credentials.username) {
          queryString += `&user=${encodeURIComponent(credentials.username)}`;
        }
        if (credentials.password) {
          queryString += `&pass=${encodeURIComponent(credentials.password)}`;
        }

        this.__connection = new window.WebSocket(
          `${this._backendUrl.protocol}//${this._backendUrl.host}${path}?${queryString}`
        );
        const socket = this.__connection;

        socket.onerror = event => {
          this.debug('SOCK ERROR', event);
        };
        socket.onclose = event => {
          this.debug('SOCK CLOSE', event);
          if (this.__connection !== socket) {
            // a previous socket that has already been replaced, it must not touch
            // the connection that took its place
            return;
          }

          this.__closeConnection(false);

          if (!this.__terminated) {
            // the connection was not closed by us, get it back
            this.__scheduleReconnect();
          }
        };
        socket.onmessage = async event => {
          const [type, id, name, args] = this.__decodeMessage(event.data);

          if (type === undefined) {
            return;
          }

          switch (type) {
            case 0: /* MESSAGE */
              switch (name) {
                case '___ready___':
                  this.__cancelReconnect();
                  this.setConnected(true);

                  // the server subscriptions belong to the connection that just went away, so
                  // everything known so far has to be subscribed again. On the very first
                  // connect there is nothing yet and __subscribeStates() returns immediately.
                  this.__subscribeStates();

                  if (callback) {
                    callback.call(context);
                  }
                  break;
                case '___setup___': /* Fake for socket.io compatibility */
                  {
                    // honour the ping interval the socket.io backend sent, but only within a sane
                    // range, so a malicious or broken server cannot turn this keepalive into a
                    // busy loop
                    let pingInterval = 25000; // engine.io default
                    const requested = Number(args.pingInterval);
                    if (requested >= 1000 && requested <= 300000) {
                      pingInterval = requested;
                    }
                    this.__pingTimer = setInterval(() => {
                      this.__connection.send('2');
                    }, pingInterval);
                  }
                  break;
                case 'reauthenticate':
                  // Credentials were rejected. Do not reconnect: ioBroker locks an
                  // account out for up to an hour after a few failed attempts, so
                  // retrying with the same (wrong) credentials would only make things
                  // worse and could lock out the correct ones. Stop and report; the
                  // user fixes the credentials and reloads.
                  this.__terminated = true;
                  this.__cancelReconnect();
                  onFailure({
                    errorMessage: 'Authentication failed!',
                    errorCode: 'login -> WebSocket(' + this._backendUrl + ')'
                  });
                  break;
                case 'stateChange':
                  if (args[1].ts === args[1].lc) {
                    this.update({ [args[0]]: args[1].val }); 
                  }
                  break;
                default:
                  this.debug('Unknown message name:', name);
                  break;
              }
              break;
            case 1: /* PING */
              this.__connection.send(JSON.stringify([2]));
              break;
            case 3: /* CALLBACK */
            {
              const requestIdx = this.__pendingRequests.findIndex(entry => entry.id === id);

              if (requestIdx < 0) {
                break; 
              }

              const request = this.__pendingRequests[requestIdx];

              this.__pendingRequests.splice(requestIdx, 1);
              request.resolve(args);
              break;
            }
            default:
              this.debug('UNKNOWN SOCK MSG', event, type, id, name, args);
              break;
          }
        };
      } catch (error) {
        onFailure({
          errorMessage: error.toString(),
          errorCode: 'login -> WebSocket(' + this._backendUrl + ')'
        });
      }
    },

    /**
     * Reject all requests that are still waiting for a response. Without this they would
     * never settle, as the answer can only arrive over the connection that is gone.
     * @param reason {String} why the requests cannot be answered anymore
     */
    __rejectPendingRequests(reason) {
      const pending = this.__pendingRequests;
      this.__pendingRequests = [];

      for (const request of pending) {
        request.reject(new Error(reason));
      }
    },

    __closeConnection(closeConnection = true) {
      if (this.isConnected()) {
        if (this.__pingTimer) {
          clearInterval(this.__pingTimer);
          this.__pingTimer = null;
        }

        if (closeConnection) {
          this.__connection.close();
        }

        this.setConnected(false);
        this.__connection = null;
      }

      this.__rejectPendingRequests('connection to ' + this._backendUrl + ' closed');
    },

    /**
     * Subscribe to the addresses in the parameter. The second parameter
     * (filter) is optional
     *
     * @param addresses {Array?} addresses to subscribe to
     * @param filters {Array?} Filters
     *
     */
    async subscribe(addresses, filters) {
      this.__subscribedAddresses = addresses;
      this.__subscribeStates();
    },

    /**
     * Add a single subscription
     * @param address {String}
     */
    addSubscription(address) {
      if (!this.__subscribedAddresses) {
        this.__subscribedAddresses = [address];
      } else if (this.__subscribedAddresses.includes(address)) {
        return;
      } else {
        this.__subscribedAddresses.push(address);
      }

      if (this.isConnected()) {
        // the connection is already established, subscribe this address right away,
        // otherwise it would not receive any updates until the next subscribe() call
        this.__subscribeAddresses([address]);
      }
    },

    /**
     * This function starts the communication by a login and then runs the
     * ongoing communication task
     *
     * @param loginOnly {Boolean} if true only login and backend configuration, no subscription
     *                            to addresses (default: false)
     * @param credentials {Map} map with "username" and "password" (optional)
     * @param callback {Function} call this function when login is done
     * @param context {Object} context for the callback (this)
     *
     */
    async login(loginOnly, credentials, callback, context) {
      this.__credentials = credentials;
      this.__initiateConnection(callback, context);
    },

    /**
     * Client is able to authorize a request, by knowing the credentials.
     * The credentials are part of the backends connection URL, they cannot be
     * applied to an arbitrary request, so this client cannot authorize one.
     * @return {Boolean}
     */
    canAuthorize() {
      return false;
    },

    /**
     * Authorize a Request by adding the necessary headers.
     * @param req {qx.io.request.Xhr}
     */
    authorize(req) {},

    /**
     * return the relative path to a resource on the currently used backend
     *
     * @param name {String} Name of the resource (e.g. login, read, write, rrd)
     * @param params {Map?} optional data needed to generate the resource path
     * @return {String|null} relative path to the resource, returns `null` when the backend does not provide that resource
     */
    getResourcePath(name, params) {
      // this backend provides none of them, the callers check for null explicitly
      return null;
    },

    /**
     * This client provides an own processor for charts data
     * @return {Boolean}
     */
    hasCustomChartsDataProcessor() {
      return false;
    },

    /**
     * For custom backend charts data some processing might be done to convert it in a format the CometVisu can handle
     * @param data {var}
     */
    processChartsData(data) {
      return data;
    },

    /**
     * This function sends a value
     * @param address {String} address to send the value to
     * @param value {String} value to send
     * @param options {Object} optional options, depending on backend
     *
     */
    write(address, value, options) {
      if (!this.isConnected()) {
        return; 
      }
  
      this.__serverSetState(address, { val: value, ack: false });
    },

    /**
     * Get the last recorded error
     *
     * @return {{code: (*|Integer), text: (*|String), response: (*|String|null), url: (*|String), time: number}|*}
     */
    getLastError() {},

    /**
     * Restart the connection
     * @param full
     */
    /**
     * Re-establish the connection. Every reconnect is a full one, the server side
     * subscriptions belong to the connection that was lost and are renewed as soon as
     * the new one is ready.
     * @param full {Boolean?} unused, kept for the cv.io.IClient signature
     */
    restart(full) {
      this.__cancelReconnect();
      this.__closeQuietly();
      this.__reconnect();
    },

    /**
     * Try to connect, as long as the application is active. While it is inactive the
     * connections are closed on purpose, reconnecting then would just fight that.
     */
    __reconnect() {
      this.__reconnectTimer = null;

      if (this.isConnected()) {
        return;
      }

      const app = qx.core.Init.getApplication();
      if (app && !app.isActive()) {
        this.debug('application is inactive, not reconnecting');

        return;
      }

      this.__reconnectAttempt++;
      this.debug('connection attempt ' + this.__reconnectAttempt);
      this.__initiateConnection();
      // the attempt is asynchronous, schedule the next one in case it does not succeed
      this.__scheduleReconnect();
    },

    /**
     * Schedule the next connection attempt, backing off from 1s up to 60s.
     */
    __scheduleReconnect() {
      if (this.__reconnectTimer || this.__terminated) {
        return;
      }

      const delay = Math.min(1000 * Math.pow(2, this.__reconnectAttempt), 60000);
      this.debug('next connection attempt in ' + delay / 1000 + 's');
      this.__reconnectTimer = setTimeout(() => this.__reconnect(), delay);
    },

    __cancelReconnect() {
      if (this.__reconnectTimer) {
        clearTimeout(this.__reconnectTimer);
        this.__reconnectTimer = null;
      }
      this.__reconnectAttempt = 0;
    },

    /**
     * Close the connection without letting the close handler schedule a reconnect.
     */
    __closeQuietly() {
      const wasTerminated = this.__terminated;
      this.__terminated = true;
      this.__closeConnection();
      this.__terminated = wasTerminated;
    },

    /**
     * Handle the incoming state updates. This method is not implemented by the client itself.
     * It is injected by the project using the client.
     * @param json
     */
    update(json) {},

    /**
     * Can be overridden to record client communication with backend
     * @param type {String} type of event to record
     * @param data {Object} data to record
     */
    record(type, data) {},

    /**
     * Can be overridden to provide an error handler for client errors
     * @param type {Number} one of cv.io.Client.ERROR_CODES
     * @param message {String} detailed error message
     * @param args
     */
    showError(type, message, args) {},

    terminate() {
      this.__terminated = true;
      this.__cancelReconnect();
      this.__closeConnection();
    },

    /**
     * Destructor
     */
    destruct() {
      this.__closeConnection();
    }
  }
});
