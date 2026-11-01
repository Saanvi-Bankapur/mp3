/*
 * Shared helpers for the users and tasks routes:
 * response formatting, error type, id checks, and query-string parsing.
 */

// An error that carries an HTTP status and a human-readable message
class ApiError extends Error {
    constructor(status, message, data) {
        super(message);
        this.status = status;
        this.data = data === undefined ? null : data;
    }
}

function send(res, status, message, data) {
    return res.status(status).json({ message: message, data: data === undefined ? null : data });
}

// Strict 24-hex-character ObjectId check (mongoose.isValidObjectId also accepts any 12-char string)
function isValidId(id) {
    return typeof id === 'string' && /^[0-9a-fA-F]{24}$/.test(id);
}

// Parse one JSON-encoded query parameter; throws a 400 on invalid JSON
function parseJsonParam(query, name) {
    if (query[name] === undefined) return undefined;
    var raw = query[name];
    if (Array.isArray(raw)) raw = raw[raw.length - 1];
    if (typeof raw !== 'string') throw new ApiError(400, 'Invalid value for "' + name + '" parameter');
    try {
        return JSON.parse(raw);
    } catch (e) {
        throw new ApiError(400, 'Invalid JSON in "' + name + '" parameter');
    }
}

function parseObjectParam(query, name) {
    var v = parseJsonParam(query, name);
    if (v === undefined) return undefined;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw new ApiError(400, 'The "' + name + '" parameter must be a JSON object');
    }
    return v;
}

function parseIntParam(query, name) {
    var v = parseJsonParam(query, name);
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new ApiError(400, 'The "' + name + '" parameter must be a non-negative integer');
    }
    return v;
}

function parseBoolParam(query, name) {
    var v = parseJsonParam(query, name);
    if (v === undefined) return false;
    if (typeof v !== 'boolean') {
        throw new ApiError(400, 'The "' + name + '" parameter must be true or false');
    }
    return v;
}

/*
 * Run a collection query (GET /users, GET /tasks) using Mongoose query methods.
 * defaultLimit: number or undefined (unlimited).
 */
async function runListQuery(Model, query, defaultLimit) {
    var where = parseObjectParam(query, 'where') || {};
    var sort = parseObjectParam(query, 'sort');
    var select = parseObjectParam(query, 'select');
    var skip = parseIntParam(query, 'skip');
    var limit = parseIntParam(query, 'limit');
    var count = parseBoolParam(query, 'count');

    try {
        if (count) {
            var options = {};
            if (skip !== undefined) options.skip = skip;
            if (limit !== undefined && limit > 0) options.limit = limit;
            return await Model.countDocuments(where, options);
        }

        var q = Model.find(where);
        if (sort) q = q.sort(sort);
        if (select) q = q.select(select);
        if (skip !== undefined) q = q.skip(skip);
        if (limit === undefined) limit = defaultLimit;
        if (limit !== undefined && limit > 0) q = q.limit(limit);
        return await q.exec();
    } catch (err) {
        throw queryError(err);
    }
}

// Turn an error caused by a bad query (bad cast, bad operator, bad projection/sort) into a 400
function queryError(err) {
    if (err instanceof ApiError) return err;
    var name = err && err.name;
    var code = err && err.code;
    // CastError / StrictModeError / BSON errors, and MongoServerError for invalid operators,
    // projections or sort values (codes 2 BadValue, 9 FailedToParse, 31254/31253 projection, 15974/15975 sort)
    if (name === 'CastError' || name === 'StrictModeError' || name === 'BSONError' ||
        name === 'ObjectParameterError' ||
        (name === 'MongoServerError' && code !== undefined && ![6, 7, 89, 91, 189, 11600, 11602].includes(code))) {
        return new ApiError(400, 'Invalid query parameters');
    }
    if (err instanceof TypeError || err instanceof RangeError) {
        return new ApiError(400, 'Invalid query parameters');
    }
    return err;
}

// Parse a "select" parameter for the /:id endpoints
function parseSelect(query) {
    return parseObjectParam(query, 'select');
}

// Wrap an async route handler: ApiErrors become their status, anything else a generic 500
function handle(fn) {
    return async function (req, res) {
        try {
            await fn(req, res);
        } catch (err) {
            if (err instanceof ApiError) {
                return send(res, err.status, err.message, err.data);
            }
            if (err && err.code === 11000) {
                return send(res, 400, 'A user with this email already exists', null);
            }
            console.error(err);
            return send(res, 500, 'Internal server error. Please try again later.', null);
        }
    };
}

module.exports = {
    ApiError: ApiError,
    send: send,
    isValidId: isValidId,
    runListQuery: runListQuery,
    parseSelect: parseSelect,
    queryError: queryError,
    handle: handle
};
