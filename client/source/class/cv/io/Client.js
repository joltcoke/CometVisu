/* Client.js 
 * 
 * copyright (c) 2010-2016, Christian Mayer and the CometVisu contributers.
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
 * The JavaScript library that implements the CometVisu protocol.
 * The Client handles all communication issues to supply the user
 * of this object with reliable realtime data.
 * It can be seen as the session layer (layer 5) according to the OSI
 * model.
 *
 * @author Christan Mayer
 * @author Tobias Bräutigam
 * @since 0.5.3 (initial contribution) 0.10.0 (major refactoring)
 */
qx.Class.define('cv.io.Client', {
  extend: qx.core.Object,

  /*
   ******************************************************
   CONSTRUCTOR
   ******************************************************
   */
  construct: function(backendName, backendUrl) {
    this.base(arguments);
    cv.io.Client.CLIENTS.push(this);
    this.backend = {};
    this.loginSettings = {
      loggedIn: false,
      callbackAfterLoggedIn: null,
      context: null,
      loginOnly: false // login only for backend configuration, do not start address subscription
    };

    // init default settings
    if (cv.io.Client.backendNameAliases[backendName]) {
      this.backendName = cv.io.Client.backendNameAliases[backendName];
    } else {
      this.backendName = backendName;
    }

    if (backendName && backendName !== 'default') {
      if (qx.lang.Type.isObject(backendName)) {
        // override default settings
        this.setBackend(backendName);
      } else if (cv.io.Client.backends[backendName]) {
        // merge backend settings into default backend
        this.setBackend(cv.io.Client.backends[backendName]);
      }
    } else {
      this.setBackend(cv.io.Client.backends['default']);
    }

    this.backendUrl = backendUrl;

    this.watchdog = new cv.io.Watchdog();
    this.watchdog.setClient(this);

    this.addresses = [];
    this.initialAddresses = [];
    this.filters = [];
    this.user = '';
    this.pass = '';
    this.device = '';
    this.headers = {};
  },

  /*
   ******************************************************
   STATICS
   ******************************************************
   */
  statics: {
    CLIENTS: [],
    TEST_MODE: false,

    /**
     * Stop all running clients
     */
    stopAll: function() {
      this.CLIENTS.forEach(function(client) {
        client.stop();
      });
    },

    // used for backwards compability
    backendNameAliases: {
      'cgi-bin': 'default',
      'oh': 'openhab',
      'oh2': 'openhab2'
    },
    // setup of the different known backends (openhab2 configures itself by sending the config with the login response
    // so no defaults are defined here
    backends: {
      'default': {
        name: 'default',
        baseURL: '/cgi-bin/',
        transport: 'long-polling',
        resources: {
          login: 'l',
          read: 'r',
          write: 'w',
          rrd: 'rrdfetch'
        },
        maxConnectionAge: 60 * 1000, // in milliseconds - restart if last read is older
        maxDataAge: 3200 * 1000, // in milliseconds - reload all data when last successful read is older (should be faster than the index overflow at max data rate, i.e. 2^16 @ 20 tps for KNX TP)
        hooks: {}
      },
      'openhab': {
        name: 'openHAB',
        baseURL: '/services/cv/',
        // keep the e.g. atmosphere tracking-id if there is one
        resendHeaders: {
          'X-Atmosphere-tracking-id': undefined
        },
        // fixed headers that are send everytime
        headers: {
          'X-Atmosphere-Transport': 'long-polling'
        },
        hooks: {
          onClose: function () {
            // send an close request to the openHAB server
            var oldValue = this.headers["X-Atmosphere-Transport"];
            this.headers["X-Atmosphere-Transport"] = "close";
            this.doRequest(this.getResourcePath('read'), null, null, null, {
              beforeSend: this.beforeSend
            });
            if (oldValue !== undefined) {
              this.headers["X-Atmosphere-Transport"] = oldValue;
            } else {
              delete this.headers["X-Atmosphere-Transport"];
            }
          }
        }
      },
      "openhab2": {
        name: "openHAB2",
        baseURL: "/rest/cv/",
        transport: "sse"
      }
    }
  },

  /*
   ******************************************************
   PROPERTIES
   ******************************************************
   */
  properties: {
    /**
     * is the communication running at the moment?
     */
    running : {
      check: "Boolean",
      init: false
    },

    /**
     * needed to be able to check if the incoming update is the initial answer or a successing update
     */
    dataReceived : {
      check: "Boolean",
      init: false
    },
    /**
     * the currently used transport layer
     */
    currentTransport: {
      init: null
    }
  },

  /*
   ******************************************************
   MEMBERS
   ******************************************************
   */
  members: {
    watchdog: null,
    backend: null,
    backendName: null,
    backendUrl: null,
    addresses: null, // the subscribed addresses
    initialAddresses: null, // the addresses which should be loaded before the subscribed addresses
    filters: null, // the subscribed filters
    user : null, // the current user
    pass : null, // the current password
    device : null, // the current device ID
    session: null, // current session ID

    loginSettings : null,
    headers: null,

    setInitialAddresses: function(addresses) {
      this.initialAddresses = addresses;
    },

    setBackend: function(newBackend) {
      // override default settings
      var backend = qx.lang.Object.mergeWith(qx.lang.Object.clone(cv.io.Client.backends['default']), newBackend);
      this.backend = backend;
      if (backend.transport === 'sse' && backend.transportFallback) {
        if (window.EventSource === undefined) {
          // browser does not support EventSource object => use fallback
          // transport + settings
          qx.lang.Object.mergeWith(backend, backend.transportFallback);
        }
      }
      // add trailing slash to baseURL if not set
      if (backend.baseURL && backend.baseURL.substr(-1) !== "/") {
        backend.baseURL += "/";
      }
      switch(backend.transport) {
        case "long-polling":
          this.setCurrentTransport(new cv.io.transport.LongPolling(this));
          break;
        case "sse":
          this.setCurrentTransport(new cv.io.transport.Sse(this));
          break;
      }
      if (this.backend.name === "openHAB") {
        // use the fallback parser
        qx.util.ResponseParser.PARSER.json = cv.io.parser.Json.parse;
      }
    },

    getBackend: function() {
      return this.backend;
    },
    /**
     * manipulates the header of the current ajax query before it is been send to the server
     */
    beforeSend : function (xhr) {
      for (var headerName in this.resendHeaders) {
        if (this.resendHeaders[headerName] !== undefined) {
          xhr.setRequestHeader(headerName, this.resendHeaders[headerName]);
        }
      }
      for (headerName in this.headers) {
        if (this.headers[headerName] !== undefined) {
          xhr.setRequestHeader(headerName, this.headers[headerName]);
        }
      }
    },

    /* return the relative path to a resource on the currently used backend
     *
     *
     *
     * @param name
     *          {String} Name of the resource (e.g. login, read, write, rrd)
     * @return {String} relative path to the resource
     */
    getResourcePath : function (name) {
      return this.backend.baseURL + this.backend.resources[name];
    },

    /**
     * Subscribe to the addresses in the parameter. The second parameter
     * (filter) is optional
     *
     * @param addresses {Array?} addresses to subscribe to
     * @param filters {Array?} Filters
     *
     */
    subscribe : function (addresses, filters) {
      var startCommunication = !this.addresses.length; // start when
      // addresses were
      // empty
      this.addresses = addresses ? addresses : [];
      this.filters = filters ? filters : [];

      if (!addresses.length) {
        this.stop(); // stop when new addresses are empty
      }
      else if (startCommunication) {
        if (this.loginSettings.loginOnly === true) {
          // connect to the backend
          this.getCurrentTransport().connect();
          // start the watchdog
          this.watchdog.start(5);
          this.loginSettings.loginOnly = false;
        }
        else {
          this.login(false);
        }
      }
    },

    /**
     * This function starts the communication by a login and then runs the
     * ongoing communication task
     *
     * @param loginOnly {Boolean} if true only login and backend configuration, no subscription to addresses (default: false)
     * @param callback {Function} call this function when login is done
     * @param context {Object} context for the callback (this)
     *
     */
    login : function (loginOnly, callback, context) {
      if (!this.loginSettings.loggedIn) {
        this.loginSettings.loginOnly = !!loginOnly;
        this.loginSettings.callbackAfterLoggedIn = callback;
        this.loginSettings.context = context;
        var request = {};
        if ('' !== this.user) {
          request.u = this.user;
        }
        if ('' !== this.pass) {
          request.p = this.pass;
        }
        if ('' !== this.device) {
          request.d = this.device;
        }
        this.doRequest(this.backendUrl ? this.backendUrl : this.getResourcePath("login"), request, this.handleLogin, this);
      } else if (this.loginSettings.callbackAfterLoggedIn) {
        // call callback immediately
        this.loginSettings.callbackAfterLoggedIn.call(this.loginSettings.context);
        this.loginSettings.callbackAfterLoggedIn = null;
        this.loginSettings.context = null;
      }
    },

    /**
     * Get the json response from the parameter received from the used XHR transport
     */
    getResponse: qx.core.Environment.select("cv.xhr", {
      "jquery": function(data) {
        if (data && $.type(data) === "string") {
          data = cv.io.parser.Json.parse(data);
        }
        return data;
      },

      "qx": function(ev) {
        if (!ev) { return null; }
        var json = ev.getTarget().getResponse();
        if (!json) { return null; }
        if (qx.lang.Type.isString(json)) {
          json = cv.io.parser.Json.parse(json);
        }
        return json;
      }
    }),

    /**
     * Creates an XHR request. The request type depends von the "cv.xhr" environment setting
     * (currently "qx" and "jquery" are supported)
     * @param url {String} URI
     * @param data {Map} request data
     * @param callback {Function} success callback
     * @param context {Object} context fot the callback
     * @return {qx.io.request.Xhr|jQuery}
     */
    doRequest: qx.core.Environment.select("cv.xhr", {
      "jquery": function(url, data, callback, context, options) {
        var config = {
          url         : url,
          dataType    : 'json',
          context     : context,
          success     : callback
        };
        if (options) {
          if (options.listeners) {
            config = $.extend(config, options.listeners);
            delete options.listeners;
          }
        }
        config = $.extend(config, options || {});
        var request = new cv.io.request.Jquery(config);
        request.send();
        return request;
      },
      "qx": function(url, data, callback, context, options) {
        var ajaxRequest = new qx.io.request.Xhr(url);
        if (options) {
          if (options.beforeSend) {
            this.beforeSend(ajaxRequest);
            delete options.beforeSend;
          }
          if (options.listeners) {
            Object.getOwnPropertyNames(options.listeners).forEach(function(eventName) {
              ajaxRequest.addListener(eventName, options.listeners[eventName], context);
            });
            delete options.listeners;
          }
        }
        ajaxRequest.set(qx.lang.Object.mergeWith({
          accept: "application/json",
          requestData: data
        }, options || {}));
        if (callback) {
          ajaxRequest.addListener("success", callback, context);
        }
        ajaxRequest.send();
        return ajaxRequest;
      }
    }),

    /**
     * Handles login response, applies backend configuration if send by
     * backend and forwards to the configurated transport handleSession
     * function
     *
     * @param ev {Event} the 'success' event from the XHR request
     */
    handleLogin : function (ev) {
      var json = this.getResponse(ev);
      // read backend configuration if send by backend
      if (json.c) {
        this.setBackend(qx.lang.Object.mergeWith(this.getBackend(), json.c));
      }
      this.session = json.s || "SESSION";

      this.setDataReceived(false);
      if (this.loginSettings.loginOnly) {
        this.getCurrentTransport().handleSession(ev, false);
      } else {
        this.getCurrentTransport().handleSession(ev, true);
        // once the connection is set up, start the watchdog
        this.watchdog.start(5);
      }
      this.loginSettings.loggedIn = true;
      if (this.loginSettings.callbackAfterLoggedIn) {
        this.loginSettings.callbackAfterLoggedIn.call(this.loginSettings.context);
        this.loginSettings.callbackAfterLoggedIn = null;
        this.loginSettings.context = null;
      }
    },

    /**
     * This function stops an ongoing connection
     *
     */
    stop : function () {
      this.setRunning(false);
      if (this.getCurrentTransport().abort) {
        this.getCurrentTransport().abort();
      }
      this.loginSettings.loggedIn = false;
      this.watchdog.stop();
    },

    /**
     * Build the URL part that contains the addresses and filters
     *
     * @param addresses {Array}
     * @return {Map}
     */
    buildRequest : function (addresses) {
      return {
        a: addresses ? addresses : this.addresses,
        f: this.filters,
        s: this.session
      };
    },

    /**
     * This function sends a value
     * @param address {String} address to send the value to
     * @param value {String} value to send
     *
     */
    write : function (address, value) {
      /**
       * ts is a quirk to fix wrong caching on some Android-tablets/Webkit;
       * could maybe selective based on UserAgent but isn't that costly on writes
       */
      var ts = new Date().getTime();
      var url = qx.util.Uri.appendParamsToUrl(this.getResourcePath("write"), 's=' + this.session + '&a=' + address + '&v=' + value + '&ts=' + ts);
      this.doRequest(url, null, null, null, {
        accept: "application/json, text/javascript, */*; q=0.01"
      });
    },

    /**
     * Restart the connection
     */
    restart: function(full) {
      this.getCurrentTransport().restart(full);
    },

    update: function(json) {}, // jshint ignore:line

    /**
     * Can be overridden to record client communication with backend
     * @param type {String} type of event to record
     * @param data {Object} data to record
     */
    record: function(type, data) {}  // jshint ignore:line
  },

  /*
  ******************************************************
    DESTRUCTOR
  ******************************************************
  */
  destruct: function() {
    this.stop();
  }
});