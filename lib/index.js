'use strict';

var $npm = {
    pg: require('pg'),
    formatting: require('./formatting'),
    context: require('./dbContext'),
    adapter: require('./adapter'),
    error: require('./qrError'),
    utils: require('./utils'),
    mode: require('./txMode'),
    camelize: require('camelize')
};

var $p; // simplified promise accessor;

/**
 * @enum {Number} queryResult
 * @readonly
 * @summary Query Result Mask.
 * @description
 * Binary mask that represents the result expected from queries.
 * It is used in the generic {@link module:pg-promise.Database#query query} method,
 * as well as method {@link module:pg-promise.Database#func func}.
 *
 * The mask is always the last optional parameter, which defaults to `queryResult.any`.
 *
 * Any combination of flags is supported, except for `one + many`.
 * @see {@link module:pg-promise.Database#query query}, {@link module:pg-promise.Database#func func}
 */
var queryResult = {
    /** Single row is expected. */
    one: 1,
    /** One or more rows expected. */
    many: 2,
    /** Expecting no rows. */
    none: 4,
    /** many|none - any result is expected. */
    any: 6
};

////////////////////////////////////////////
// Database interface (for internal usage);
function Database(cn, options) {
    /**
     * @method connect
     * @memberof module:pg-promise.Database.prototype
     * @summary Retrieves a new or existing connection from the pool, based on the
     * current connection parameters.
     * @description
     * This method initiates a shared connection for executing a chain of queries
     * on the same connection. The connection must be released in the end of the
     * chain by calling method `done()` of the connection object.
     * This is a legacy, low-level approach to chaining queries on the same connection.
     * A newer and simpler approach is via method {@link module:pg-promise.Database#task task},
     * which allocates and releases the shared connection automatically.
     * @returns {external:Promise} Connection result:
     * <ul>
     * <li>resolves with the connection object, if successful. The object has method `done()` that must
     *   be called in the end of the query chain, in order to release the connection back to the pool.</li>
     * <li>rejects with the connection error when fails.</li>
     * </ul>
     * @see {@link module:pg-promise.Database#task task}
     */
    this.connect = function () {
        var ctx = createContext();
        var self = {
            // Generic query method;
            query: function (query, values, qrm) {
                if (!ctx.db) {
                    throw new Error("Cannot execute a query on a disconnected client.");
                }
                return $query.call(this, ctx, query, values, qrm);
            },
            // Connection release method;
            done: function () {
                if (!ctx.db) {
                    throw new Error("Cannot invoke done() on a disconnected client.");
                }
                ctx.disconnect();
            }
        };
        $extend(ctx, self); // extending the protocol;
        return $connect(ctx)
            .then(function (db) {
                ctx.connect(db);
                return self;
            });
    };

    /**
     * @method query
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a generic query that expects return data according to parameter `qrm`
     * @param {String|Object} query -
     * - query string
     * - prepared statement object
     * - function object
     * - stream object
     * @param {Array|value} [values] - formatting parameters for the query string
     * @param {queryResult} [qrm=queryResult.any] - {@link queryResult Query Result Mask}
     * @returns {external:Promise} A promise object that represents the query result.
     */
    this.query = function (query, values, qrm) {
        var self = this, ctx = createContext();
        return $connect(ctx)
            .then(function (db) {
                ctx.connect(db);
                return $query.call(self, ctx, query, values, qrm);
            })
            .then(function (data) {
                ctx.disconnect();
                return data;
            })
            .catch(function (error) {
                ctx.disconnect();
                return $p.reject(error);
            });
    };

    $extend(createContext(), this); // extending root protocol;

    function createContext() {
        return new $npm.context(cn, options);
    }
}

/**
 * @constructor module:pg-promise.Task
 * @summary Internal Task implementation.
 */
function Task(ctx, tag, isTX) {

    this.ctx = ctx.ctx = {}; // task context object;

    $npm.utils.addReadProp(this.ctx, 'isTX', isTX);

    if ('context' in ctx) {
        $npm.utils.addReadProp(this.ctx, 'context', ctx.context);
    }

    if (tag !== undefined) {
        $npm.utils.addReadProp(this.ctx, 'tag', tag);
    }

    // generic query method;
    this.query = function (query, values, qrm) {
        if (!ctx.db) {
            throw new Error("Unexpected call outside of " + (isTX ? "transaction." : "task."));
        }
        return $query.call(this, ctx, query, values, qrm);
    };

    /**
     * @method batch
     * @memberof module:pg-promise.Task.prototype
     * @summary Resolves a predefined array of mixed values by redirecting to method $[spex.batch].
     * @description
     * For complete method documentation see $[spex.batch].
     * @param {Array} values
     * @param {Function} [cb]
     * @returns {external:Promise}
     */
    this.batch = function (values, cb) {
        return $npm.spex.batch.call(this, values, cb);
    };

    /**
     * @method page
     * @memberof module:pg-promise.Task.prototype
     * @summary Resolves a dynamic sequence of arrays/pages with mixed values, by redirecting to method $[spex.page].
     * @description
     * For complete method documentation see $[spex.page].
     * @param {Function} source
     * @param {Function} [dest]
     * @param {Number} [limit=0]
     * @returns {external:Promise}
     */
    this.page = function (source, dest, limit) {
        return $npm.spex.page.call(this, source, dest, limit);
    };

    /**
     * @method sequence
     * @memberof module:pg-promise.Task.prototype
     * @summary Resolves a dynamic sequence of mixed values by redirecting to method $[spex.sequence].
     * @description
     * For complete method documentation see $[spex.sequence].
     * @param {Function} source
     * @param {Function} [dest]
     * @param {Number} [limit=0]
     * @param {Boolean} [track=false]
     * @returns {external:Promise}
     */
    this.sequence = function (source, dest, limit, track) {
        return $npm.spex.sequence.call(this, source, dest, limit, track);
    };

    $extend(ctx, this); // extending task protocol;
}

/////////////////////////////
// Special Query type;
function SpecialQuery(type) {
    this.isStream = type === 'stream';
    this.isResult = type === 'result';
}

var $cache = {
    resultQuery: new SpecialQuery('result'),
    streamQuery: new SpecialQuery('stream')
};

////////////////////////////////////////////////////
// Injects additional methods into an access object,
// extending the protocol's base method 'query'.
function $extend(ctx, obj) {

    /**
     * @method none
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query that expects no data to be returned.
     * @param {String|Object} query -
     * - query string
     * - prepared statement object
     * @param {Array|value} [values] - formatting parameters for the query string
     * @returns {external:Promise} Result of the query call
     * - when no records are returned, the returned promise will resolve with `undefined`
     * - when the query returns any data, it will reject with {@link module:pg-promise~QueryResultError QueryResultError}
     * = `No return data was expected.`
     */
    obj.none = function (query, values) {
        return obj.query.call(this, query, values, queryResult.none);
    };

    /**
     * @method one
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query that expects exactly one row of data.
     * @param {String|Object} query -
     * - query string
     * - prepared statement object
     * @param {Array|value} [values] - formatting parameters for the query string
     * @returns {external:Promise} Result of the query call:
     * - when 1 row is returned, it will resolve with that row as a single object;
     * - when no rows are returned, it will reject with {@link module:pg-promise~QueryResultError QueryResultError}
     * = `No data returned from the query.`
     * - when more than 1 rows are returned, it will reject with {@link module:pg-promise~QueryResultError QueryResultError}
     * = `Multiple rows were not expected.`
     */
    obj.one = function (query, values) {
        return obj.query.call(this, query, values, queryResult.one);
    };

    /**
     * @method many
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query that expects one or more rows.
     * @param {String|Object} query -
     * - query string
     * - prepared statement object
     * @param {Array|value} [values] - formatting parameters for the query string
     * @returns {external:Promise} Result of the query call:
     * - when 1 or more rows are returned, it will resolve with the array of rows.
     * - when no rows are returned, it will reject with {@link module:pg-promise~QueryResultError QueryResultError}
     * = `No data returned from the query.`
     */
    obj.many = function (query, values) {
        return obj.query.call(this, query, values, queryResult.many);
    };

    /**
     * @method oneOrNone
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query that expects 0 or 1 rows.
     * @param {String|Object} query -
     * - query string
     * - prepared statement object
     * @param {Array|value} [values] - formatting parameters for the query string
     * @returns {external:Promise} Result of the query call:
     * - when no rows are returned, it will resolve with `null`;
     * - when 1 row is returned, it will resolve with that row as a single object;
     * - when more than 1 rows are returned, it will reject with {@link module:pg-promise~QueryResultError QueryResultError}
     * = `Multiple rows were not expected.`
     */
    obj.oneOrNone = function (query, values) {
        return obj.query.call(this, query, values, queryResult.one | queryResult.none);
    };

    /**
     * @method manyOrNone
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query that expects any number of rows.
     * @param {String|Object} query -
     * - query string
     * - prepared statement object
     * @param {Array|value} [values] - formatting parameters for the query string
     * @returns {external:Promise} Result of the query call:
     * - when no rows are returned, it will resolve with an empty array;
     * - when 1 or more rows are returned, it will resolve with the array of rows.
     * @see {@link module:pg-promise.Database#any Database.any}
     */
    obj.manyOrNone = function (query, values) {
        return obj.query.call(this, query, values, queryResult.many | queryResult.none);
    };

    /**
     * Alias for method {@link module:pg-promise.Database#manyOrNone manyOrNone}
     * @method any
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query that expects any number of rows.
     * @param {String|Object} query -
     * - query string
     * - prepared statement object
     * @param {Array|value} [values] - formatting parameters for the query string
     * @returns {external:Promise} The same as method {@link module:pg-promise.Database#manyOrNone manyOrNone}
     * @see {@link module:pg-promise.Database#manyOrNone manyOrNone}
     */
    obj.any = function (query, values) {
        return obj.query.call(this, query, values, queryResult.any);
    };

    /**
     * @method result
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query without any expectation for the return data, to provide direct access
     * to the $[Result] object.
     * @param {String|Object} query -
     * - query string
     * - prepared statement object
     * @param {Array|value} [values] - formatting parameters for the query string
     * @returns {external:Promise} Result of the query call:
     * - resolves with the original $[Result] object
     */
    obj.result = function (query, values) {
        return obj.query.call(this, query, values, $cache.resultQuery);
    };

    /**
     * @method stream
     * @memberof module:pg-promise.Database.prototype
     * @summary Custom data streaming, with the help of $[pg-query-stream].
     * @param {QueryStream} qs - stream object of type $[QueryStream].
     * @param {Function} init - stream initialization callback, with
     * the same `this` context as the calling method.
     * @returns {external:Promise} Result of the streaming operation.
     *
     * Once the streaming has finished successfully, the method resolves with
     * `{processed, duration}`:
     * - `processed` - total number of rows that have been processed;
     * - `duration` - streaming duration, in milliseconds.
     *
     * Possible rejections messages:
     * - `Invalid or missing stream object.`
     * - `Invalid stream state.`
     * - `Invalid or missing stream initialization callback.`
     */
    obj.stream = function (qs, init) {
        return obj.query.call(this, qs, init, $cache.streamQuery);
    };

    /**
     * @method func
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query against a database function by its name:
     * `select * from funcName(values)`
     * @param {String} funcName - name of the function to be executed.
     * @param {Array|value} [values] - parameters for the function.
     * @param {queryResult} [qrm=queryResult.any] - {@link queryResult Query Result Mask}.
     * @returns {external:Promise} Result of the query call, according to `qrm`.
     * @see {@link module:pg-promise.Database#query query}
     */
    obj.func = function (funcName, values, qrm) {
        return obj.query.call(this, {
            funcName: funcName
        }, values, qrm);
    };

    /**
     * @method proc
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes a query against a stored procedure via its name:
     * `select * from procName(values)`
     * @param {String} procName - name of the stored procedure to be executed.
     * @param {Array|value} [values] - parameters for the procedure.
     * @returns {external:Promise} The same result as method {@link module:pg-promise.Database#oneOrNone oneOrNone}.
     * @see {@link module:pg-promise.Database#oneOrNone oneOrNone}
     * @see {@link module:pg-promise.Database#func func}
     */
    obj.proc = function (procName, values) {
        return obj.func.call(this, procName, values, queryResult.one | queryResult.none);
    };

    /**
     * @method task
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes the callback function with an automatically managed connection.
     * @param {Object|Function|generator} p1 - task tag object, if `p2` is `undefined`,
     * or else it is the callback function for the task.
     * @param {Function} [p2] - task callback function, if it is not `undefined`,
     * or else `p2` isn't used.
     * @returns {external:Promise} Result from the task callback function.
     */
    obj.task = function (p1, p2) {
        return taskProcessor.call(this, p1, p2, false);
    };

    /**
     * @method tx
     * @memberof module:pg-promise.Database.prototype
     * @summary Executes the callback function as a transaction.
     * @description
     * Executes a task as a transaction. The transaction will do `ROLLBACK`,
     * if the callback function returns a rejected promise or throws an error;
     * and it will do `COMMIT` in all other cases.
     * @param {Object|Function|generator} p1 - transaction tag object, if `p2`
     * is `undefined`, or else it is the callback function for the transaction.
     * @param {Function} [p2] - transaction callback function, if it is not `undefined`,
     * or else `p2` isn't used.
     * @returns {external:Promise} Result from the transaction callback function.
     */
    obj.tx = function (p1, p2) {
        return taskProcessor.call(this, p1, p2, true);
    };

    // Task method;
    // Resolves with result from the callback function;
    function taskProcessor(p1, p2, isTX) {

        var tag, // tag object/value;
            taskCtx = ctx.clone(); // task context object;

        if (isTX) {
            taskCtx.txLevel = taskCtx.txLevel >= 0 ? (taskCtx.txLevel + 1) : 0;
        }

        if (this !== obj) {
            taskCtx.context = this; // calling context object;
        }

        taskCtx.cb = p1; // callback function;

        // allow inserting a tag in front of the callback
        // function, for better code readability;
        if (p2 !== undefined) {
            tag = p1; // overriding any default tag;
            taskCtx.cb = p2;
        }

        var cb = taskCtx.cb;

        if (typeof cb !== 'function') {
            return $p.reject("Callback function is required for the " + (isTX ? "transaction." : "task."));
        }

        if (tag === undefined) {
            if (cb.tag !== undefined) {
                // use the default tag associated with the task:
                tag = cb.tag;
            } else {
                if (cb.name) {
                    tag = cb.name; // use the function name as tag;
                }
            }
        }

        var tsk = new Task(taskCtx, tag, isTX);

        if (taskCtx.db) {
            // reuse existing connection;
            return $task(taskCtx, tsk, isTX);
        }

        // connection required;
        return $connect(taskCtx)
            .then(function (db) {
                taskCtx.connect(db);
                return $task(taskCtx, tsk, isTX);
            })
            .then(function (data) {
                taskCtx.disconnect();
                return data;
            })
            .catch(function (error) {
                taskCtx.disconnect();
                return $p.reject(error);
            });
    }

    // lock all default properties to read-only,
    // to prevent override by the client.
    $npm.utils.lock(obj, false, ctx.options);

    // extend the protocol;
    $notify.extend(ctx.options, obj);

    // freeze the protocol permanently;
    $npm.utils.lock(obj, true, ctx.options);
}

//////////////////////////////
// Generic query method;
function $query(ctx, query, values, qrm) {
    var isResult = false;
    if (qrm instanceof SpecialQuery) {
        if (qrm.isStream) {
            return $stream.call(this, ctx, query, values);
        }
        isResult = qrm.isResult;
    }
    var errMsg, textErr,
        isFunc = $npm.utils.isObject(query, ['funcName']), // function call;
        isPS = $npm.utils.isObject(query, ['name', 'text']), // prepared statement;
        opt = ctx.options,
        pgFormatting = (opt && opt.pgFormatting) || isPS,
        params = pgFormatting ? values : undefined,
        camelizeResult = (opt && opt.camelizeResult);

    return $p(function (resolve, reject) {

        if (isFunc) {
            query = query.funcName; // query is a function name;
        }
        if (!pgFormatting && !$npm.utils.isText(query)) {
            textErr = isFunc ? "Function name" : "Parameter 'query'";
        }
        if (isPS) {
            if (!$npm.utils.isText(query.name)) {
                textErr = "Property 'name' in prepared statement";
            } else {
                if (!$npm.utils.isText(query.text)) {
                    textErr = "Property 'text' in prepared statement";
                }
            }
        }
        if (textErr) {
            errMsg = textErr + " must be a non-empty text string.";
        }
        if (!errMsg && !isResult) {
            if ($npm.utils.isNull(qrm)) {
                qrm = queryResult.any; // default query result;
            } else {
                var badMask = queryResult.one | queryResult.many; // the combination isn't supported;
                var isInteger = typeof qrm === 'number' && isFinite(qrm) && Math.floor(qrm) === qrm;
                if (!isInteger || (qrm & badMask) === badMask || qrm < 1 || qrm > 6) {
                    errMsg = "Invalid Query Result Mask specified.";
                }
            }
        }
        if (!errMsg && (!pgFormatting || isFunc)) {
            try {
                // use 'pg-promise' implementation of values formatting;
                if (isFunc) {
                    query = $npm.formatting.formatFunction(query, values);
                } else {
                    query = $npm.formatting.formatQuery(query, values);
                }
            } catch (err) {
                if (isFunc) {
                    query = "select * from " + query + "(...)";
                }
                errMsg = err;
                params = values;
            }
        }
        if (notifyReject()) {
            return;
        }
        errMsg = $notify.query(opt, {
            client: ctx.db.client,
            query: query,
            params: params,
            ctx: ctx.ctx
        });
        if (notifyReject()) {
            return;
        }
        try {
            ctx.db.client.query(query, params, function (err, result) {
                var data;
                if (err) {
                    errMsg = err;
                } else {
                    if (isResult) {
                        data = result; // raw object requested (Result type);
                    } else {
                        data = result.rows;
                        var len = data.length;
                        if (len) {
                            if (len > 1 && qrm & queryResult.one) {
                                // one row was expected, but returned multiple;
                                errMsg = "Multiple rows were not expected.";
                            } else {
                                if (!(qrm & (queryResult.one | queryResult.many))) {
                                    // no data should have been returned;
                                    errMsg = "No return data was expected.";
                                } else {
                                    if (!(qrm & queryResult.many)) {
                                        data = data[0];
                                    }
                                }
                            }
                        } else {
                            // no data returned;
                            if (qrm & queryResult.none) {
                                if (qrm & queryResult.one) {
                                    data = null;
                                } else {
                                    data = qrm & queryResult.many ? [] : undefined;
                                }
                            } else {
                                errMsg = "No data returned from the query.";
                            }
                        }
                        if (errMsg) {
                            errMsg = new $npm.error(errMsg);
                        }
                    }
                }
                if (!notifyReject()) {
                    if (camelizeResult) {
                        resolve($npm.camelize(data));
                    } else {
                        resolve(data);
                    }
                }
            });
        } catch (err) {
            // can only happen when pgFormatting = true;
            errMsg = err;
        }

        notifyReject();

        function notifyReject() {
            var client;
            if (ctx.db) {
                client = ctx.db.client;
            } else {
                errMsg = "Loose request outside an expired connection.";
            }
            if (errMsg !== undefined) {
                $notify.error(opt, errMsg, {
                    client: client,
                    query: query,
                    params: params,
                    ctx: ctx.ctx
                });
                reject(errMsg);
                return true;
            }
        }
    });
}

////////////////////////////////////////////
// Streams query data into any destination,
// with help from pg-query-stream library.
function $stream(ctx, qs, init) {
    if (!$npm.utils.isObject(qs, ['state', '_reading'])) {
        // stream object wasn't passed in correctly;
        return $p.reject("Invalid or missing stream object.");
    }
    if (qs._reading || qs.state !== 'initialized') {
        // stream object is in the wrong state;
        return $p.reject("Invalid stream state.");
    }
    if (typeof init !== 'function') {
        // parameter `init` must be passed as the initialization callback;
        return $p.reject("Invalid or missing stream initialization callback.");
    }
    var error = $notify.query(ctx.options, {
        client: ctx.db.client,
        query: qs.text,
        params: qs.values,
        ctx: ctx.ctx
    });
    if (error) {
        $notify.error(ctx.options, error, {
            client: ctx.db.client,
            query: qs.text,
            params: qs.values,
            ctx: ctx.ctx
        });
        return $p.reject(error);
    }
    var stream, fetch, start, nRows = 0;
    try {
        stream = ctx.db.client.query(qs);
        fetch = stream._fetch;
        stream._fetch = function (size, func) {
            fetch.call(stream, size, function (err, rows) {
                nRows += err ? 0 : rows.length;
                return func(err, rows);
            });
        };
        start = Date.now();
        init.call(this, stream); // the stream must be initialized during the call;
    } catch (err) {
        error = err;
    }
    if (error) {
        stream._fetch = fetch;
        $notify.error(ctx.options, error, {
            client: ctx.db.client,
            query: qs.text,
            params: qs.values,
            ctx: ctx.ctx
        });
        return $p.reject(error);
    }
    return $p(function (resolve, reject) {
        stream.once('end', function () {
            stream._fetch = fetch;
            resolve({
                processed: nRows, // total number of rows processed;
                duration: Date.now() - start // duration, in milliseconds;
            });
        });
        stream.once('error', function (err) {
            stream._fetch = fetch;
            $notify.error(ctx.options, err, {
                client: ctx.db.client,
                query: qs.text,
                params: qs.values,
                ctx: ctx.ctx
            });
            reject(err);
        });
    });
}

///////////////////////////////////////////////
// Acquires and resolves with a new connection
// object from the connection pool;
function $connect(ctx) {
    return $p(function (resolve, reject) {
        $npm.pg.connect(ctx.cn, function (err, client, done) {
            if (err) {
                $notify.error(ctx.options, err, {
                    cn: $npm.utils.getSafeConnection(ctx.cn)
                });
                reject(err);
            } else {
                resolve({
                    client: client,
                    done: function () {
                        done();
                        $notify.disconnect(ctx.options, client);
                    }
                });
                $notify.connect(ctx.options, client);
            }
        });
    });
}

///////////////////////////////////////
// Implements a task/transaction logic;
function $task(ctx, obj, isTX) {

    // callback invocation helper;
    function callback() {
        var result, cb = ctx.cb;
        if (cb.constructor.name === 'GeneratorFunction') {
            cb = $npm.async(cb);
        }
        try {
            result = cb.call(obj, obj); // invoking the callback function;
        } catch (err) {
            $notify.error(ctx.options, err, {
                client: ctx.db.client,
                ctx: ctx.ctx
            });
            return $p.reject(err); // reject with the error;
        }
        if (result && result.then instanceof Function) {
            return result; // result is a valid promise object;
        }
        return $p.resolve(result);
    }

    // updates the task context and notifies the client;
    function update(start, success, result) {
        var c = ctx.ctx;
        if (start) {
            $npm.utils.addReadProp(c, 'start', new Date());
        } else {
            c.finish = new Date();
            c.success = success;
            c.result = result;
            $npm.utils.lock(c, true);
        }
        (isTX ? $notify.transact : $notify.task)(ctx.options, {
            client: ctx.db.client,
            ctx: c
        });
    }

    var cbData, cbReason, success,
        spName, // Save-Point Name;
        capTX = ctx.options && ctx.options.capTX; // capitalize transaction commands;

    update(true);

    if (isTX) {
        // executing a transaction;
        spName = "level_" + ctx.txLevel;
        return begin()
            .then(function () {
                    return callback()
                        .then(function (data) {
                            cbData = data; // save callback data;
                            success = true;
                            return commit();
                        }, function (reason) {
                            cbReason = reason; // save callback failure reason;
                            return rollback();
                        })
                        .then(function () {
                                if (success) {
                                    update(false, true, cbData);
                                    return cbData;
                                } else {
                                    update(false, false, cbReason);
                                    return $p.reject(cbReason);
                                }
                            },
                            // istanbul ignore next: either `commit` or `rollback` has failed, which is
                            // impossible to replicate in a test environment, so skipping from the test;
                            function (reason) {
                                update(false, false, reason);
                                return $p.reject(reason);
                            });
                },
                // istanbul ignore next: `begin` has failed, which is impossible
                // to replicate in a test environment, so skipping from the test;
                function (reason) {
                    update(false, false, reason);
                    return $p.reject(reason);
                });
    }

    function begin() {
        if (!ctx.txLevel && ctx.cb.txMode instanceof $npm.mode.TransactionMode) {
            var b = ctx.cb.txMode.begin(capTX);
            return capTX ? exec(b, 'SAVEPOINT') : exec(b, 'savepoint');
        }
        return capTX ? exec('BEGIN', 'SAVEPOINT') : exec('begin', 'savepoint');
    }

    function commit() {
        return capTX ? exec('COMMIT', 'RELEASE SAVEPOINT') : exec('commit', 'release savepoint');
    }

    function rollback() {
        return capTX ? exec('ROLLBACK', 'ROLLBACK TO SAVEPOINT') : exec('rollback', 'rollback to savepoint');
    }

    function exec(top, nested) {
        return obj.none(ctx.txLevel ? nested + ' ' + spName : top);
    }

    // executing a task;
    return callback()
        .then(function (data) {
            update(false, true, data);
            return data;
        })
        .catch(function (error) {
            update(false, false, error);
            return $p.reject(error);
        });

}

/////////////////////////////////
// Client notification helpers;
var $notify = {
    /**
     * @event connect
     * @memberof module:pg-promise
     * @summary Global notification function of acquiring a new database
     * connection from the connection pool, i.e. a virtual connection.
     * @param {pg.Client} client - $[pg.Client] object that represents the database connection.
     */
    connect: function (options, client) {
        if (options && options.connect instanceof Function) {
            try {
                options.connect(client);
            } catch (err) {
                // have to silence errors here;
                // cannot allow unhandled errors while connecting to the database,
                // as it will break the connection logic;
                $notify.unexpected('connect', err);
            }
        }
    },
    /**
     * @event disconnect
     * @memberof module:pg-promise
     * @summary Global notification function of releasing a database connection
     * back to the connection pool, i.e. releasing the virtual connection.
     * @param {pg.Client} client - $[pg.Client] object that represents the database connection.
     */
    disconnect: function (options, client) {
        if (options && options.disconnect instanceof Function) {
            try {
                options.disconnect(client);
            } catch (err) {
                // have to silence errors here;
                // cannot allow unhandled errors while disconnecting from the database,
                // as it will break the disconnection logic;
                $notify.unexpected('disconnect', err);
            }
        }
    },
    /**
     * @event query
     * @memberof module:pg-promise
     * @summary Global notification of a query that's about to execute.
     * @param {Object} e - event context object.
     */
    query: function (options, context) {
        if (options && options.query instanceof Function) {
            try {
                options.query(context);
            } catch (err) {
                // throwing an error during event 'query'
                // will result in a reject for the query.
                return err;
            }
        }
    },
    /**
     * @event task
     * @memberof module:pg-promise
     * @summary Global notification of a task start / finish events.
     * @param {Object} e - event context object.
     */
    task: function (options, context) {
        if (options && options.task instanceof Function) {
            try {
                options.task(context);
            } catch (err) {
                // silencing the error, to avoid breaking the task;
                $notify.unexpected('task', err);
            }
        }
    },
    /**
     * @event transact
     * @memberof module:pg-promise
     * @summary Global notification of a transaction start / finish events.
     * @param {Object} e - event context object.
     */
    transact: function (options, context) {
        if (options && options.transact instanceof Function) {
            try {
                options.transact(context);
            } catch (err) {
                // silencing the error, to avoid breaking the transaction;
                $notify.unexpected('transact', err);
            }
        }
    },
    /**
     * @event error
     * @memberof module:pg-promise
     * @summary Global notification of an error during connection, query, task or transaction.
     * @param {String|Error} err - error text or object.
     * @param {Object} e - event context object.
     */
    error: function (options, err, context) {
        if (options && options.error instanceof Function) {
            try {
                options.error(err, context);
            } catch (err) {
                // have to silence errors here;
                // throwing unhandled errors while handling an error
                // notification is simply not acceptable.
                $notify.unexpected('error', err);
            }
        }
    },
    /**
     * @event extend
     * @memberof module:pg-promise
     * @summary Extends database protocol with custom methods and properties.
     * @param {Object} obj - protocol object to be extended.
     */
    extend: function (options, obj) {
        if (options && options.extend instanceof Function) {
            try {
                options.extend.call(obj, obj);
            } catch (err) {
                // have to silence errors here;
                // the result of throwing unhandled errors while
                // extending the protocol would be unpredictable.
                $notify.unexpected('extend', err);
            }
        }
    },
    /**
     * @event unexpected
     * @memberof module:pg-promise
     * @param {String} event - unhandled event name.
     * @param {String|Error} err - unhandled error.
     * @private
     */
    unexpected: function (event, err) {
        // If you should ever get here, your app is definitely broken, and you need to fix
        // your event handler to prevent unhandled errors during event notifications.
        //
        // Console output is suppressed when running tests, to avoid polluting test output
        // with error messages that are intentional and of no value to the test.

        /* istanbul ignore if */
        if (!$main.suppressErrors) {
            console.error("Unexpected error in '" + event + "' event handler.");
            if (!$npm.utils.isNull(err)) {
                console.error(err.stack || err.message || err);
            }
        }
    }
};

/**
 * Complete access layer to node-postgres via $[Promises/A+]
 * @module pg-promise
 * @author Vitaly Tomilov
 * @param {Object} [options]
 * Library initialization options:
 * - `pgFormatting` - redirects query formatting to PG;
 * - `promiseLib` - overrides default promise library;
 * - `connect` - database `connect` notification;
 * - `disconnect` - database `disconnect` notification;
 * - `query` - query execution notification;
 * - `task` - task event notification;
 * - `transact` - transaction event notification;
 * - `error` - error event notification;
 * - `extend` - protocol extension event;
 * - `noLocking` - prevents protocol locking;
 * - `capTX` - capitalizes transaction commands.
 */
function $main(options) {

    if (!$npm.utils.isNull(options) && typeof options !== 'object') {
        throw new TypeError("Invalid parameter 'options' specified.");
    }

    var promiseLib = options ? options.promiseLib : null;

    if (promiseLib) {
        $p = $npm.utils.parsePromiseLib(promiseLib);
    } else {
        // istanbul ignore if
        // Excluding from coverage, because it is
        // only triggered for NodeJS prior to 0.12
        if (typeof Promise === 'undefined') {
            // ES6 Promise isn't supported, NodeJS is pre-0.12;
            throw new TypeError("Promise library must be specified.");
        }
        $p = $npm.utils.parsePromiseLib(Promise);
        promiseLib = Promise;
    }

    // Specialized Promise Extensions;
    $npm.spex = require('spex')(promiseLib);

    // Support for generators;
    $npm.async = require('./async')($p);

    /**
     * @constructor module:pg-promise.Database
     * @param {String|Object} cn
     * Connection object or string.
     * @returns {Database}
     * New database instance.
     */
    var inst = function (cn) {
        var t = typeof cn;
        if (cn && (t === 'string' || t === 'object')) {
            return new Database(cn, options);
        }
        // cannot access a database without connection details;
        throw new TypeError("Invalid connection details.");
    };

    $npm.utils.addProperties(inst, rootNameSpace);
    $npm.utils.lock(inst);

    return inst;
}

var rootNameSpace = {
    /**
     * Terminates pg library (call it when exiting the application).
     * @alias module:pg-promise.end
     */
    end: function () {
        $npm.pg.end();
    },

    /**
     * Namespace for the type conversion helpers.
     * @alias module:formatting.as
     * @member {module:formatting.as} as
     * @readonly
     */
    as: $npm.formatting.as,

    /**
     * Instance of the PG library used.
     * @alias module:pg-promise.pg
     */
    pg: $npm.pg,

    /**
     * Query Result Mask.
     * @alias module:pg-promise.queryResult
     * @readonly
     */
    queryResult: queryResult,

    /**
     * Query Result Error type.
     * @alias module:error
     * @member {module:error} QueryResultError
     * @readonly
     */
    QueryResultError: $npm.error,

    /**
     * Promise Adapter.
     * @alias module:adapter
     * @member {module:adapter} PromiseAdapter
     * @readonly
     */
    PromiseAdapter: $npm.adapter,

    /**
     * Instance of the Transaction Mode library.
     * @alias module:txMode
     * @member {module:txMode} txMode
     * @readonly
     */
    txMode: $npm.mode
};

$npm.utils.lock(rootNameSpace.as, true);
$npm.utils.lock(rootNameSpace.txMode, true);
$npm.utils.lock(rootNameSpace.PromiseAdapter, true);
$npm.utils.lock(rootNameSpace.QueryResultError, true);
$npm.utils.lock(rootNameSpace.queryResult, true);

$npm.utils.addProperties($main, rootNameSpace);

module.exports = $main;

/**
 * @external Promise
 * @see https://developer.mozilla.org/en/docs/Web/JavaScript/Reference/Global_Objects/Promise
 */
