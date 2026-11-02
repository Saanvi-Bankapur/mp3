var mongoose = require('mongoose');
var User = require('../models/user.js');
var Task = require('../models/task.js');
var h = require('./helpers.js');
var ApiError = h.ApiError;

var EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

/*
 * Validate the request body of POST /users and PUT /users/:id.
 * Returns { name, email, pendingTasks } or throws a 400.
 */
function parseUserBody(req) {
    var body = req.body || {};
    var form = req.is('application/x-www-form-urlencoded');

    var name = body.name;
    if (typeof name !== 'string' || name.trim() === '') {
        throw new ApiError(400, 'A user must have a name');
    }
    name = name.trim();

    var email = body.email;
    if (typeof email !== 'string' || email.trim() === '') {
        throw new ApiError(400, 'A user must have an email');
    }
    email = email.trim();
    if (!EMAIL_RE.test(email)) {
        throw new ApiError(400, 'The email address is not valid');
    }

    var pending = body.pendingTasks;
    if (pending === undefined || pending === null) {
        pending = [];
    } else if (form && typeof pending === 'string') {
        // a single value sent as a form field
        pending = pending === '' ? [] : [pending];
    }
    if (!Array.isArray(pending)) {
        throw new ApiError(400, 'pendingTasks must be a list of task ids');
    }
    var seen = new Set();
    var ids = [];
    for (var i = 0; i < pending.length; i++) {
        var id = pending[i];
        if (!h.isValidId(id)) {
            throw new ApiError(400, 'pendingTasks contains an invalid task id');
        }
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
        }
    }

    return { name: name, email: email, pendingTasks: ids };
}

/*
 * Checks that need the database: unique email, tasks exist, tasks are not completed.
 */
async function checkUserReferences(fields, userId) {
    var emailFilter = { email: fields.email };
    if (userId) emailFilter._id = { $ne: userId };
    if (await User.exists(emailFilter)) {
        throw new ApiError(400, 'A user with this email already exists');
    }

    if (fields.pendingTasks.length === 0) return;
    var tasks = await Task.find({ _id: { $in: fields.pendingTasks } }).select({ completed: 1 });
    if (tasks.length !== fields.pendingTasks.length) {
        throw new ApiError(404, 'One or more tasks in pendingTasks do not exist');
    }
    if (tasks.some(function (t) { return t.completed; })) {
        throw new ApiError(400, 'A completed task cannot be in pendingTasks');
    }
}

/*
 * Bring tasks (and other users) in line with this user's new pendingTasks.
 */
async function syncTasksForUser(userId, name, newIds, oldIds) {
    var uid = String(userId);
    var removed = (oldIds || []).filter(function (id) { return newIds.indexOf(id) === -1; });

    // Tasks that moved here are taken out of any other user's pendingTasks
    if (newIds.length > 0) {
        await User.updateMany(
            { _id: { $ne: userId }, pendingTasks: { $in: newIds } },
            { $pull: { pendingTasks: { $in: newIds } } }
        );
    }

    // Pending tasks no longer in the list become unassigned
    await Task.updateMany(
        {
            assignedUser: uid,
            _id: { $nin: newIds },
            $or: [{ completed: false }, { _id: { $in: removed } }]
        },
        { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
    );

    // Tasks in the list are assigned to this user
    if (newIds.length > 0) {
        await Task.updateMany(
            { _id: { $in: newIds } },
            { $set: { assignedUser: uid, assignedUserName: name } }
        );
    }

    // Everything still assigned to this user (completed too) carries the current name
    await Task.updateMany({ assignedUser: uid }, { $set: { assignedUserName: name } });
}

module.exports = function (router) {

    var usersRoute = router.route('/users');
    var userRoute = router.route('/users/:id');

    // GET /users
    usersRoute.get(h.handle(async function (req, res) {
        var result = await h.runListQuery(User, req.query, undefined);
        h.send(res, 200, 'OK', result);
    }));

    // POST /users
    usersRoute.post(h.handle(async function (req, res) {
        var fields = parseUserBody(req);
        await checkUserReferences(fields, null);

        var user = new User({
            name: fields.name,
            email: fields.email,
            pendingTasks: fields.pendingTasks
        });
        await user.save();
        await syncTasksForUser(user._id, user.name, fields.pendingTasks, []);

        h.send(res, 201, 'User created', user);
    }));

    // GET /users/:id
    userRoute.get(h.handle(async function (req, res) {
        if (!h.isValidId(req.params.id)) throw new ApiError(404, 'User not found');
        var select = h.parseSelect(req.query);
        var user;
        try {
            var q = User.findById(req.params.id);
            if (select) q = q.select(select);
            user = await q.exec();
        } catch (err) {
            throw h.queryError(err);
        }
        if (!user) throw new ApiError(404, 'User not found');
        h.send(res, 200, 'OK', user);
    }));

    // PUT /users/:id
    userRoute.put(h.handle(async function (req, res) {
        if (!h.isValidId(req.params.id)) throw new ApiError(404, 'User not found');
        var user = await User.findById(req.params.id);
        if (!user) throw new ApiError(404, 'User not found');

        var fields = parseUserBody(req);
        await checkUserReferences(fields, user._id);

        var oldIds = (user.pendingTasks || []).slice();
        user.name = fields.name;
        user.email = fields.email;
        user.pendingTasks = fields.pendingTasks;
        await user.save();
        await syncTasksForUser(user._id, user.name, fields.pendingTasks, oldIds);

        h.send(res, 200, 'User updated', user);
    }));

    // DELETE /users/:id
    userRoute.delete(h.handle(async function (req, res) {
        if (!h.isValidId(req.params.id)) throw new ApiError(404, 'User not found');
        var user = await User.findByIdAndDelete(req.params.id);
        if (!user) throw new ApiError(404, 'User not found');

        await Task.updateMany(
            { assignedUser: String(user._id) },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
        );

        res.status(204).end();
    }));

    return router;
};
