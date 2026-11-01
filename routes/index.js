/*
 * Connect all of your endpoints together here.
 */
module.exports = function (app, router) {
    require('./home.js')(router);
    require('./users.js')(router);
    require('./tasks.js')(router);
    app.use('/api', router);

    // Unknown endpoints
    app.use(function (req, res) {
        res.status(404).json({ message: 'Endpoint not found', data: null });
    });

    // Errors thrown before reaching a route (e.g. a request body that is not valid JSON)
    app.use(function (err, req, res, next) {
        if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
            return res.status(400).json({ message: 'The request body is not valid JSON', data: null });
        }
        console.error(err);
        res.status(500).json({ message: 'Internal server error. Please try again later.', data: null });
    });
};
