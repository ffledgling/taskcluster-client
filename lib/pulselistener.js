var events    = require('events');
var util      = require('util');
var amqplib   = require('amqplib');
var Promise   = require('promise');
var debug     = require('debug')('taskcluster-client:PulseListener');
var _         = require('lodash');
var assert    = require('assert');
var slugid    = require('slugid');
var URL       = require('url');

/**
 * Build Pulse ConnectionString, from options on the form:
 * {
 *   username:          // Pulse username (optional, if connectionString)
 *   password:          // Pulse password (optional, if connectionString)
 *   hostname:          // Hostname to use (defaults to pulse.mozilla.org)
 * }
 */
var buildPulseConnectionString = function(options) {
  assert(options.username, "options.username password is required");
  assert(options.password, "options.password is required");

  // Construct connection string
  return [
    'amqps://',         // Ensure that we're using SSL
    options.username,
    ':',
    options.password,
    '@',
    options.hostname || 'pulse.mozilla.org',
    ':',
    5671                // Port for SSL
  ].join('');
};

/**
 * Create PulseConnection from `options` on the form:
 * {
 *   namespace:         // Namespace to prefix queues/exchanges (optional)
 *                      // defaults to `username` if given otherwise ""
 *   username:          // Username to connect with (and namespace if not given)
 *   password:          // Password to connect with
 *   hostname:          // Hostname to connect to using username/password
 *                      // defaults to pulse.mozilla.org
 *   connectionString:  // connectionString cannot be used with username,
 *                      // password and/or hostname.
 * }
 */
var PulseConnection = function(options) {
  assert(typeof(options) === 'object', "options is required");
  options = _.defaults({}, options, {
    namespace:          options.username || ''
  });

  if (!options.connectionString) {
    options.connectionString = buildPulseConnectionString(options);
  } else {
    assert(!options.username, "Can't take `username` along with `connectionString`");
    assert(!options.password, "Can't take `password` along with `connectionString`");
    assert(!options.hostname, "Can't take `hostname` along with `connectionString`");
  }

  // If namespace was not explicitly set infer it from connection string...
  if (!options.namespace) {
    var parsed = URL.parse(options.connectionString);
    options.namespace = parsed.auth.split(':')[0];
  }

  this.namespace = options.namespace;
  this._connectionString = options.connectionString;

  // Private properties
  this._conn              = null;
  this._connecting        = false;
};

// Inherit from events.EventEmitter
util.inherits(PulseConnection, events.EventEmitter);

/** Returns a promise for a connection */
PulseConnection.prototype.connect = function() {
  var that = this;

  // Connection if we have one
  if (this._conn) {
    return Promise.resolve(this._conn);
  }

  // If currently connecting, give a promise for this result
  var retval = new Promise(function(accept, reject) {
    that.once('connection', function(err, conn) {
      if (err) {
        return reject(err);
      }
      return accept(conn);
    });
  });

  // Connect if we're not already doing this
  if (!this._connecting) {
    this._connecting = true;
    amqplib.connect(this._connectionString).then(function(conn) {
      // Save reference to the connection
      that._conn = conn;

      // Setup error handling
      conn.on('error', function(err) {
        debug("Connection error in Connection: %s", err, err.stack);
        that.emit('error', err);
      });

      // We're no longer connecting, emit event notifying anybody waiting
      that._connecting = false;
      that.emit('connection', null, conn);
    }).then(null, function(err) {
      // Notify of connection error
      that.emit('connection', err);
    });
  }

  // Return promise waiting for event
  return retval;

};

/** Close the connection */
PulseConnection.prototype.close = function() {
  var conn = this._conn;
  if (conn) {
    this._conn = null;
    return conn.close();
  }
  return Promise.resolve(undefined);
};


// Export PulseConnection
exports.PulseConnection = PulseConnection;

/**
 * Create new PulseListener
 *
 * options: {
 *   prefetch:            // Max number of messages unacknowledged to hold
 *   queueName:           // Queue name, defaults to exclusive auto-delete queue
 *   connection:          // PulseConnection object (or credentials)
 *   credentials: {
 *     namespace:         // Namespace to prefix queues/exchanges (optional)
 *                        // defaults to `username` if given otherwise ""
 *     username:          // Pulse username
 *     password:          // Pulse password
 *     hostname:          // Hostname to connect to using username/password
 *                        // defaults to pulse.mozilla.org
 *     connectionString:  // connectionString overwrites username/password and
 *                        // hostname (if given)
 *   }
 *   maxLength:           // Maximum queue size, undefined for none
 * }
 *
 * You must provide `connection` either as an instance of `PulseConnection` or
 * as options given to `PulseConnection`. If options for `PulseConnection` is
 * given, then the connection will be closed along with the listener.
 */
var PulseListener = function(options) {
  var that = this;
  assert(options,             "options are required");
  assert(options.connection ||
         options.credentials, "options.connection or credentials is required");
  this._bindings = [];
  this._options = _.defaults(options, {
    prefetch:               5,
    queueName:              undefined,
    maxLength:              undefined
  });
  // Ensure that we have connection object
  this._connection = options.connection || null;
  if (!(this._connection instanceof PulseConnection)) {
    this._connection = new PulseConnection(options.credentials);
    // If listener owner the connection, then connection errors are also
    // listener errors
    this._connection.on('error', function(err) {
      that.emit('error', err);
    });
  }
};

// Inherit from events.EventEmitter
util.inherits(PulseListener, events.EventEmitter);

/**
 * Bind listener to exchange with routing key and optional routing key
 * reference used to parse routing keys.
 *
 * binding: {
 *   exchange:              '...',  // Exchange to bind
 *   routingKeyPattern:     '...',  // Routing key as string
 *   routingKeyReference:   {...}   // Reference used to parse routing keys
 * }
 *
 * if `routingKeyReference` is provided for the exchange from which messages
 * arrive the listener will parse the routing key and make it available as a
 * dictionary on the message.
 *
 * **Note,** the arguments for this method is easily constructed using an
 * instance of `Client`, see `createClient`.
 */
PulseListener.prototype.bind = function(binding) {
  assert(typeof(binding.exchange) === 'string',
         "Can't bind to unspecified exchange!");
  assert(typeof(binding.routingKeyPattern) === 'string',
         "routingKeyPattern is required!");
  this._bindings.push(binding);
  if(this._channel) {
    debug("Binding %s to %s with pattern '%s'",
          this._queueName || 'exclusive queue',
          binding.exchange, binding.routingKeyPattern);
    return this._channel.bindQueue(
      this._queueName,
      binding.exchange,
      binding.routingKeyPattern
    );
  } else {
    return Promise.resolve(null);
  }
};

/** Connect, setup queue and binding to exchanges */
PulseListener.prototype.connect = function() {
  var that = this;

  // Return channel if we have one
  if (this._channel) {
    return Promise.resolve(this._channel);
  }

  // Create AMQP connection and channel
  var channel = null;
  var channelCreated = this._connection.connect().then(function(conn) {
    that._conn = conn;
    return that._conn.createConfirmChannel();
  }).then(function(channel_) {
    channel = channel_;
    channel.on('error', function(err) {
      // Prevent invalidation of the connection, by someone calling .close()
      // this way channel.close() won't be called when .close() is called.
      that._channel = null;
      debug("Channel error in PulseListener: ", err.stack);
      that.emit('error', err);
    });
    return channel.prefetch(that._options.prefetch);
  });

  // Find queue name and decide if this is an exclusive queue
  var exclusive = !this._options.queueName;
  // Construct queue name
  this._queueName = [
    'queue',                      // Required by pulse security model
    this._connection.namespace,   // Required by pulse security model
    this._options.queueName || 'exclusive/' + slugid.v4()
  ].join('/')

  // Create queue
  var queueCreated = channelCreated.then(function() {
    var opts = {
      exclusive:  exclusive,
      durable:    !exclusive,
      autoDelete: exclusive,
    };
    // Set max length if provided
    if (that._options.maxLength) {
      opts.maxLength =  that._options.maxLength;
    }
    return channel.assertQueue(that._queueName, opts);
  });

  // Create bindings
  var bindingsCreated = queueCreated.then(function() {
    that._channel = channel;
    return Promise.all(that._bindings.map(function(binding) {
      debug("Binding %s to %s with pattern %s",
            that._queueName || 'exclusive queue',
            binding.exchange, binding.routingKeyPattern);
      return channel.bindQueue(
        that._queueName,
        binding.exchange,
        binding.routingKeyPattern
      );
    }));
  });

  // Begin consumption
  return bindingsCreated.then(function() {
    return channel;
  });
};

/** Pause consumption of messages */
PulseListener.prototype.pause = function() {
  if (!this._channel) {
    debug("WARNING: Paused PulseListener instance was wasn't connected yet");
    return;
  }
  assert(this._channel, "Can't pause when not connected");
  return this._channel.cancel(this._consumerTag);
};

/** Connect or resume consumption of message */
PulseListener.prototype.resume = function() {
  var that = this;
  return this.connect().then(function(channel) {
    return channel.consume(that._queueName, function(msg) {
      that._handle(msg);
    }).then(function(result) {
      that._consumerTag = result.consumerTag;
    });
  });
};

/** Handle message*/
PulseListener.prototype._handle = function(msg) {
  var that = this;
  // Construct message
  var message = {
    payload:      JSON.parse(msg.content.toString('utf8')),
    exchange:     msg.fields.exchange,
    routingKey:   msg.fields.routingKey,
    redelivered:  msg.fields.redelivered,
    routes:       []
  };

  // Find CC'ed routes
  if (msg.properties && msg.properties.headers &&
      msg.properties.headers.CC instanceof Array) {
    message.routes = msg.properties.headers.CC.filter(function(route) {
      // Only return the CC'ed routes that starts with "route."
      return /^route\.(.*)$/.test(route);
    }).map(function(route) {
      // Remove the "route."
      return /^route\.(.*)$/.exec(route)[1];
    });
  }

  // Find routing key reference, if any is available to us
  var routingKeyReference = null;
  this._bindings.forEach(function(binding) {
    if(binding.exchange === message.exchange && binding.routingKeyReference) {
      routingKeyReference = binding.routingKeyReference;
    }
  });

  // If we have a routing key reference we can parse the routing key
  if (routingKeyReference) {
    try {
      var routing = {};
      var keys = message.routingKey.split('.');
      // first handle non-multi keys from the beginning
      for(var i = 0; i < routingKeyReference.length; i++) {
        var ref = routingKeyReference[i];
        if (ref.multipleWords) {
          break;
        }
        routing[ref.name] = keys.shift();
      }
      // If we reached a multi key
      if (i < routingKeyReference.length) {
        // then handle non-multi keys from the end
        for(var j = routingKeyReference.length - 1; j > i; j--) {
          var ref = routingKeyReference[j];
          if (ref.multipleWords) {
            break;
          }
          routing[ref.name] = keys.pop();
        }
        // Check that we only have one multiWord routing key
        assert(i == j, "i != j really shouldn't be the case");
        routing[routingKeyReference[i].name] = keys.join('.');
      }

      // Provide parsed routing key
      message.routing = routing;
    }
    catch(err) {
      // Ideally we should rethrow the exception. But since it's not quite
      // possible to promise that `routing` (the parsed routing key) is
      // available... As you can subscribe without providing a routing
      // key reference.
      // In short people can assume this is present in most cases, and if they
      // assume this we get the error at a level where they can handle it.
      debug("Failed to parse routingKey: %s for %s with err: %s, as JSON: %j",
            message.routingKey, message.exchange, err, err, err.stack);
    }
  }

  // Process handlers
  Promise.all(this.listeners('message').map(function(handler) {
    return Promise.resolve(null).then(function() {
      return handler.call(that, message);
    });
  })).then(function() {
    return that._channel.ack(msg);
  }).then(null, function(err) {
    debug("Failed to process message %j from %s with error: %s, as JSON: %j",
          message, message.exchange, err, err, err.stack);
    if (message.redelivered) {
      debug("Nack (without requeueing) message %j from %s",
            message, message.exchange);
      return that._channel.nack(msg, false, false);
    } else {
      // Nack and requeue
      return that._channel.nack(msg, false, true);
    }
  }).then(null, function(err) {
    debug("CRITICAL: Failed to nack message");
    that.emit('error', err);
  });
};

/**
 * Deletes the underlying queue and closes the listener
 *
 * Use this if you want to delete a named queue, unnamed queues created with
 * this listener will be automatically deleted, when the listener is closed.
 */
PulseListener.prototype.deleteQueue = function() {
  var that = this;
  return this.connect().then(function(channel) {
    return channel.deleteQueue(that._queueName).then(function() {
      that.close();
    });
  });
};

/** Close the PulseListener */
PulseListener.prototype.close = function() {
  var connection = this._connection;

  // If we were given connection by option, we shouldn't close it
  if (connection === this._options.connection) {
    var channel = this._channel;
    if (channel) {
      this._channel = null;
      return channel.close();
    }
    return Promise.resolve(undefined);
  }

  // If not external connection close it
  this._conn = null;
  this._channel = null;
  return connection.close();
};

// Export PulseListener
exports.PulseListener = PulseListener;
