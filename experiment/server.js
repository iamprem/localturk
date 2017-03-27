
// "Local Turk" server for running Mechanical Turk-like tasks locally.
//
// Usage:
// node localturk.js template.html taskDir outputs.csv

var assert = require('assert'),
    mysql = require("mysql"),
    fs = require('fs'),
    http = require('http'),
    express = require('express'),
    bodyParser = require('body-parser'),
    errorhandler = require('errorhandler'),
    path = require('path'),
    program = require('commander'),
    open = require('open'),
    session = require('client-sessions')
    cookieParser = require('cookie-parser');

program
  .version('1.2.2')
  .usage('[options] template.html')
  .option('-p, --port <n>', 'Run on this port (default 4321)', parseInt)
  .parse(process.argv);
var args = program.args;
if (1 != args.length) {
  program.help();
}

var template_file = args[0];

var port = program.port || 4321;

function sqlConnection() {
  return mysql.createConnection({
    host: "localhost",
    user: "bukky",
    password: "",
    database: "localturk"
  });
}

var active_users = {}

function checkValidUser(username){
  return true
}

function htmlEntities(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderTemplate(template_file, task, finished_count, num_tasks, ready_cb) {
  fs.readFile(template_file, function(err, data) {
    if (err) {
      ready_cb(err);
      return;
    }

    data = data.toString();
    for (var k in task) {
      data = data.split('${' + k + '}').join(htmlEntities(task[k] || ''));
    }

    var out = "<!doctype html><html><body><form action=/task method=post>\n";
    out += '<p>' + finished_count + ' / ' + num_tasks + '</p>\n';
    for (var k in task) {
      out += "<input type=hidden name='" + k + "' value=\"" + htmlEntities(task[k] || '') + "\" />";
    }
    out += data;
    out += '<hr/><p class="text-center">';
    out += '<input type="submit" name="action" class="btn btn-primary" value="Previous" formnovalidate> &nbsp; &nbsp; &nbsp; '
    out += '<input type="submit" name="action" class="btn btn-primary" value="Submit">&nbsp; &nbsp; &nbsp; '
    out += '<input type="submit" name="action" class="btn btn-primary" value="Dont Know" formnovalidate></p>'
    out += "</form></body></html>\n";

    ready_cb(null, out);
  });
}


function getNextTask(task_cb, done_cb, foruser) {
  con = sqlConnection()
  con.query(
    'SELECT task_id, user, status, image_url FROM tasks WHERE user = ? AND status = \'READY\' ORDER BY task_id ASC LIMIT 1',
    foruser,
    function(err, rows) {
      if (rows.length == 1) {
        task = {};
        row = rows[0];
        for (var k in row) {
          task[k] = row[k];
        }
        con.query(
          'SELECT COUNT(*) as finished_count FROM tasks WHERE user = ? AND status != \'READY\'',
          foruser,
          function(err, rows) {
            finished_count = rows[0]['finished_count'];
            con.query(
              'SELECT COUNT(*) as count FROM tasks WHERE user = ?',
              foruser,
              function(err, rows) {
                total_count = rows[0]['count'];
                task_cb(task, finished_count, total_count);
              });
          });
      } else{
        done_cb()
      }
    });
}

function getPreviousTask(task_id, task_cb, done_cb, foruser) {
  con = sqlConnection();
  con.query(
    'SELECT task_id, user, status, image_url FROM tasks WHERE user = ? AND task_id < ? ORDER BY task_id DESC LIMIT 1',
    [foruser, task_id],
    function(err, rows) {
      if (rows.length == 1) {
        task = {};
        row = rows[0];
        for (var k in row) {
          task[k] = row[k];
        }
        con.query(
          'SELECT COUNT(*) as finished_count FROM tasks WHERE user = ? AND status != \'READY\'',
          foruser,
          function(err, rows) {
            finished_count = rows[0]['finished_count'];
            con.query(
              'SELECT COUNT(*) as count FROM tasks WHERE user = ?',
              foruser,
              function(err, rows) {
                total_count = rows[0]['count'];
                task_cb(task, finished_count, total_count);
              });
          });
      } else {
        done_cb()
      }
    }
  )
}

function writeTask(task, ready_cb) {
  con = sqlConnection();
  console.log(task);
  con.query(
    'UPDATE tasks SET status = ?, image_category = ? WHERE task_id = ?',
    [task['status'], task['image_category'], task['task_id']],
    function(err, result) {
      ready_cb(err, result)
    }
  )
}

// --- begin server ---
var app = express();
app.use(bodyParser.urlencoded({extended: true}))
app.set('views', __dirname);
app.set("view options", {layout: false});
app.use(errorhandler({
    dumpExceptions:true,
    showStack:true
}));
app.use(session({
  cookieName: 'session',
  secret: 'random_string_goes_here',
  duration: 7 * 24 * 60 * 60 * 1000,
  activeDuration: 7 * 24 * 60 * 60 * 1000,
}));
app.use(cookieParser())



app.get('/login', function(req, res) {
  username = req.cookies['username']
  if (username !== undefined && active_users[username] !== undefined) {
    res.redirect('/task')
  } else{
    res.sendFile(__dirname + '/login.html');
  }
})

app.post('/login', function(req, res) {
  username = req.body.username
  if (checkValidUser(username) && active_users[username] === undefined) {
    active_users[username] = username
    res.cookie('username', username);
    res.redirect('/task');
  } else if (active_users[username] !== undefined) {
    console.log('User already logged in')
    res.cookie('username', username);
    res.redirect('/task');
  } else {
    console.log('Invalid user \'%s\' for this task. Contact admin', username)
    res.send('User not authenticated for the task');
  }
});

app.get("/task", function(req, res) {
  foruser = req.cookies['username']
  if (active_users[foruser]) {
    getNextTask(
      function(task, finished_tasks, num_tasks) {
        renderTemplate(template_file, task, finished_tasks, num_tasks, function(e, data) {
          res.send(data);
        });
      },
      function() {
        res.send('All tasks are completed.');
      },
      foruser);
  } else {
    res.send('User not authenticated for tasks')
  }
});

app.post("/task", function(req, res) {
  switch (req.body.action) {
    case 'Dont Know':
      var task = req.body;
      task['status'] = 'SKIPPED'
      task['image_category'] = null
      writeTask(task, function(e, result) {
        if (e) {
          res.send('FAIL: ' + JSON.stringify(e));
        } else {
          console.log('Skipped ' + JSON.stringify(result));
          res.redirect('/task');
        }
      });
      break;
    case 'Submit':
      var task = req.body;
      task['status'] = 'DONE'
      writeTask(task, function(e, result) {
        if (e) {
          throw e
          res.send('FAIL: ' + JSON.stringify(e));
        } else {
          console.log('Saved ' + JSON.stringify(result));
          res.redirect('/task');
        }
      });
      break;
    case 'Previous':
      foruser = req.cookies['username'];
      if (active_users[foruser]) {
        var task = req.body;
        getPreviousTask(
          task['task_id'],
          function(task, finished_tasks, num_tasks) {
            renderTemplate(template_file, task, finished_tasks, num_tasks, function(e, data) {
              res.send(data);
            });
          },
          function() {
            res.send('No previous task. Reached first task');
          },
          foruser);
      }
      break;
    default:
  }

});

app.listen(port);
console.log('Running local turk on http://localhost:' + port)
open('http://localhost:' + port + '/login');
