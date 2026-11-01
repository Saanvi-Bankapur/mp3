var User = require('../models/user.js');
var Task = require('../models/task.js');
var h = require('./helpers.js');
var ApiError = h.ApiError;

function parseDate(value) {
    var d;
    if (typeof value === 'number') {
        d = new Date(value);
    } else if (typeof value === 'string' && value.trim() !== '') {
        var s = value.trim();
        d = /^-?\d+$/.test(s) ? new Date(Number(s)) : new Date(s);
    } else {
        return null;
    }
    return isNaN(d.getTime()) ? null : d;
}

/*
 * Validate the request body of POST /tasks and PUT /tasks/:id.
 * Returns the task fields (with defaults) or throws a 400.
 */
function parseTaskBody(req) {
    var body = req.body || {};

    var name = body.name;
    if (typeof name !== 'string' || name.trim() === '') {
        throw new ApiError(400, 'A task must have a name');
    }
    name = name.trim();

    if (body.deadline === undefined || body.deadline === null || body.deadline === '') {
        throw new ApiError(400, 'A task must have a deadline');
    }
    var deadline = parseDate(body.deadline);
    if (!deadline) {
        throw new ApiError(400, 'The deadline is not a valid date');
    }

    var description = body.description;
    if (description === undefined || description === null) {
        description = '';
    } else if (typeof description !== 'string') {
        throw new ApiError(400, 'description must be a string');
    }

    var completed = body.completed;
    if (completed === undefined || completed === null || completed === '') {
        completed = false;
    } else if (typeof completed === 'string' && /^(true|false)$/i.test(completed.trim())) {
        completed = completed.trim().toLowerCase() === 'true';
    } else if (typeof completed !== 'boolean') {
        throw new ApiError(400, 'completed must be true or false');
    }

    var assignedUser = body.assignedUser;
    if (assignedUser === undefined || assignedUser === null) {
        assignedUser = '';
    } else if (typeof assignedUser !== 'string') {
        throw new ApiError(400, 'assignedUser must be a user id');
    }
    assignedUser = assignedUser.trim();
    if (assignedUser !== '' && !h.isValidId(assignedUser)) {
        throw new ApiError(400, 'assignedUser is not a valid user id');
    }

    var assignedUserName = body.assignedUserName;
    if (assignedUserName === null) assignedUserName = undefined;
    if (assignedUserName !== undefined && typeof assignedUserName !== 'string') {
        throw new ApiError(400, 'assignedUserName must be a string');
    }

    if (assignedUser === '') {
        if (assignedUserName !== undefined && assignedUserName !== '' && assignedUserName !== 'unassigned') {
            throw new ApiError(400, 'assignedUserName is set but the task has no assignedUser');
        }
        assignedUserName = 'unassigned';
    }

    return {
        name: name,
        description: description,
        deadline: deadline,
        completed: completed,
        assignedUser: assignedUser,
        assignedUserName: assignedUserName
    };
}

/*
 * Checks that need the database: the assigned user exists and the name matches.
 */
async function checkTaskReferences(fields) {
    if (fields.assignedUser === '') return;
    var user = await User.findById(fields.assignedUser).select({ name: 1 });
    if (!user) {
        throw new ApiError(404, 'The assigned user does not exist');
    }
    if (fields.assignedUserName === undefined || fields.assignedUserName === '') {
        fields.assignedUserName = user.name;
    } else if (fields.assignedUserName !== user.name) {
        throw new ApiError(400, 'assignedUserName does not match the name of the assigned user');
    }
}

/*
 * Keep users' pendingTasks in line with this task.
 */
async function syncUsersForTask(task) {
    var tid = String(task._id);

    // No other user may list this task
    var others = { pendingTasks: tid };
    if (task.assignedUser) others._id = { $ne: task.assignedUser };
    await User.updateMany(others, { $pull: { pendingTasks: tid } });

    if (task.assignedUser) {
        var update = task.completed
            ? { $pull: { pendingTasks: tid } }
            : { $addToSet: { pendingTasks: tid } };
        await User.updateOne({ _id: task.assignedUser }, update);
    }
}

module.exports = function (router) {

    var tasksRoute = router.route('/tasks');
    var taskRoute = router.route('/tasks/:id');

    // GET /tasks
    tasksRoute.get(h.handle(async function (req, res) {
        var result = await h.runListQuery(Task, req.query, 100);
        h.send(res, 200, 'OK', result);
    }));

    // POST /tasks
    tasksRoute.post(h.handle(async function (req, res) {
        var fields = parseTaskBody(req);
        await checkTaskReferences(fields);

        var task = new Task(fields);
        await task.save();
        await syncUsersForTask(task);

        h.send(res, 201, 'Task created', task);
    }));

    // GET /tasks/:id
    taskRoute.get(h.handle(async function (req, res) {
        if (!h.isValidId(req.params.id)) throw new ApiError(404, 'Task not found');
        var select = h.parseSelect(req.query);
        var task;
        try {
            var q = Task.findById(req.params.id);
            if (select) q = q.select(select);
            task = await q.exec();
        } catch (err) {
            throw h.queryError(err);
        }
        if (!task) throw new ApiError(404, 'Task not found');
        h.send(res, 200, 'OK', task);
    }));

    // PUT /tasks/:id
    taskRoute.put(h.handle(async function (req, res) {
        if (!h.isValidId(req.params.id)) throw new ApiError(404, 'Task not found');
        var task = await Task.findById(req.params.id);
        if (!task) throw new ApiError(404, 'Task not found');

        var fields = parseTaskBody(req);
        await checkTaskReferences(fields);

        task.name = fields.name;
        task.description = fields.description;
        task.deadline = fields.deadline;
        task.completed = fields.completed;
        task.assignedUser = fields.assignedUser;
        task.assignedUserName = fields.assignedUserName;
        await task.save();
        await syncUsersForTask(task);

        h.send(res, 200, 'Task updated', task);
    }));

    // DELETE /tasks/:id
    taskRoute.delete(h.handle(async function (req, res) {
        if (!h.isValidId(req.params.id)) throw new ApiError(404, 'Task not found');
        var task = await Task.findByIdAndDelete(req.params.id);
        if (!task) throw new ApiError(404, 'Task not found');

        await User.updateMany(
            { pendingTasks: String(task._id) },
            { $pull: { pendingTasks: String(task._id) } }
        );

        h.send(res, 200, 'Task deleted', task);
    }));

    return router;
};
