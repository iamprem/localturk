#!/usr/bin/env node

// "Local Turk" server for running Mechanical Turk-like tasks locally.
//
// Usage:
// node localturk.js template.html tasks.csv outputs.csv

var assert = require('assert'),
    csv = require('csv'),
    csvParse = require('csv-parse'),
    fs = require('fs'),
    http = require('http'),
    express = require('express'),
    bodyParser = require('body-parser'),
    errorhandler = require('errorhandler'),
    path = require('path'),
    program = require('commander'),
    open = require('open'),
    session = require('client-sessions')
    ;

program
  .version('1.2.2')
  .usage('[options] template.html tasks.csv outputs.csv')
  .option('-s, --static_dir <dir>', 'Serve static content from this directory')
  .option('-p, --port <n>', 'Run on this port (default 4321)', parseInt)
  .option('-q, --quit_on_done', 'Quit when done with all tasks.')
  .parse(process.argv);

var args = program.args;
if (3 != args.length) {
  program.help();
}

var template_file = args[0],
    tasks_file = args[1],
    outputs_file = args[2];

var port = program.port || 4321,
    static_dir = program.static_dir || null;

// Task is a dictionary. completed_tasks is a list of dictionaries,
// each containing a superset of the keys in the input task.  Returns true if
// there's a completed task which has all the key/value pairs in |task|.
function isTaskCompleted(task, completed_tasks) {
  for (var i = 0; i < completed_tasks.length; i++) {
    var d = completed_tasks[i];
    var match = true;
    for (var k in task) {
      var dnorm = d[k].replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      var tasknorm = task[k].replace(/\r/g, '\n');
      if (!(k in d) || dnorm != tasknorm) {
        match = false;
        break;
      }
    }

    if (match) return true;
  }
  return false;
}

// Find an object containing k/v pairs for the next task.
// Fires either task_cb(kv_pairs_for_task) or done_cb() if there are no tasks
// remaining.
function getNextTask(task_cb, done_cb) {
  var completed_tasks = [];
  var cb_fired = false;
  var parser = makeParser();
  var finished_count = 0;
  parser
    .on('readable', function() {
      var record;
      while (record = parser.read()) {
        // XXX old code skipped the first row
        completed_tasks.push(record);
        finished_count++;
      }
    })
    .on('finish', function() {
      var task = null;
      // Now read the inputs until we find one which hasn't been completed.
      var parser = makeParser();
      var total_count = 0;
      parser
        .on('readable', function() {
          var record;
          while (record = parser.read()) {
            total_count++;
            if (!task && !isTaskCompleted(record, completed_tasks)) {
              task = record;
            }
          }
        })
        .on('finish', function() {
          if (task) {
            task_cb(task, finished_count, total_count);
          } else {
            done_cb();
          }
        });

      fs.createReadStream(tasks_file).pipe(parser);
    });

  fs.createReadStream(outputs_file).pipe(parser);
}

function htmlEntities(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// Hacked out of node CSV module, because its API is incomprehensible.
function quoteLine(line) {
  var csv = {
    writeOptions: {
      delimiter: ',',
      quote: '"',
      escape: '"'
    }
  };
  if(line instanceof Array){
    var newLine = '';
    for(var i=0; i<line.length; i++){
      var field = line[i];
      if(typeof field === 'string'){
        // fine 99% of the cases, keep going
      }else if(typeof field === 'number'){
        // Cast number to string
        field = '' + field;
      }else if(typeof field === 'boolean'){
        // Cast boolean to string
        field = field ? '1' : '';
      }else if(field instanceof Date){
        // Cast date to timestamp string
        field = '' + field.getTime();
      }
      if(field){
        var containsdelimiter = field.indexOf(csv.writeOptions.delimiter || csv.readOptions.delimiter) >= 0;
        var containsQuote = field.indexOf(csv.writeOptions.quote || csv.readOptions.quote) >= 0;
        var containsLinebreak = field.indexOf("\r") >= 0 || field.indexOf("\n") >= 0;
        if(containsQuote){
          field = field.replace(
              new RegExp(csv.writeOptions.quote || csv.readOptions.quote,'g')
              , (csv.writeOptions.escape || csv.readOptions.escape)
              + (csv.writeOptions.quote || csv.readOptions.quote));
        }

        if(containsQuote || containsdelimiter || containsLinebreak || csv.writeOptions.quoted){
          field = (csv.writeOptions.quote || csv.readOptions.quote) + field + (csv.writeOptions.quote || csv.readOptions.quote);
        }
        newLine += field;
      }
      if(i!==line.length-1){
        newLine += csv.writeOptions.delimiter || csv.readOptions.delimiter;
      }
    }
  }
  return newLine;
}

// Reads the template file and instantiates it with the task dictionary.
// Fires ready_cb(null, instantiated template) on success, or with an error.
function renderTemplate(template_file, task, ready_cb) {
  fs.readFile(template_file, function(err, data) {
    if (err) {
      ready_cb(err);
      return;
    }

    data = data.toString();
    for (var k in task) {
      data = data.split('${' + k + '}').join(htmlEntities(task[k] || ''));
    }

    ready_cb(null, data);
  });
}

function makeParser() {
  return csvParse({columns: true, skip_empty_lines: true});
}

// Write a new completed task dictionary to the file.
// TODO(danvk): preserve column ordering.
function writeCompletedTask(task, completed_tasks_file, ready_cb) {
  var old_headers = {}, new_headers = [];
  for (var k in task) {
    new_headers[k] = 1;
  }

  var parser = makeParser();
  parser
    .on('readable', function() {
      var record;
      while (record = parser.read()) {
        for (var k in record) {
          old_headers[k] = 1;
        }
      }
    })
    .on('finish', function() {
      // Merge old & new headers.
      var num_old_headers = 0;
      for (var k in old_headers) {
        num_old_headers++;
        new_headers[k] = 1;
      }
      var ordered_cols = [];
      for (var k in new_headers) {
        ordered_cols.push(k);
      }
      ordered_cols.sort();

      var new_line = [];
      for (var i = 0; i < ordered_cols.length; i++) {
        var k = ordered_cols[i];
        new_line.push(k in task ? task[k] : '');
      }

      var to_write = '';
      if (num_old_headers == 0) {
        to_write += quoteLine(ordered_cols);
      }
      to_write += '\n' + quoteLine(new_line);

      fs.appendFile(completed_tasks_file, to_write, function(e) {
        assert.ifError(e);
        ready_cb();
      });
    });

  fs.createReadStream(completed_tasks_file).pipe(parser);
}

function deleteLastTask(completed_tasks_file, ready_cb) {
  fs.readFile(completed_tasks_file, 'utf8', function(err, text) {
    if (err) {
      ready_cb(err);
      return;
    }

    var lines = text.split('\n');
    if (lines.length === 0) {
      ready_cb({error: 'Cannot delete task from empty file'});
      return;
    }

    // There may or may not be a trailing newline. Back out from the last
    // line just to make sure we really delete something.
    for (var i = lines.length - 1; i >= 0; i--) {
      if (lines[i] !== '') break;
    }

    if (lines[i] === '') {
      ready_cb({error: 'All lines in file were blank.'});
      return;
    }

    console.log('Deleting ', lines[i]);
    lines = lines.slice(0, i);
    text = lines.join('\n') + '\n';
    fs.writeFile(completed_tasks_file, text, 'utf8', function(err) {
      if (err) {
        ready_cb(err);
      } else {
        ready_cb();
      }
    });
  });
}

if (!fs.existsSync(outputs_file)) {
  fs.writeFileSync(outputs_file, '');
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

if (static_dir) {
  app.use(express.static(path.resolve(static_dir)));
}

app.get('/login', function(req, res) {
  res.sendFile(__dirname + '/login.html');
})

app.post('/login', function(req, res) {
  username = req.body.username
  res.cookie('username', username)
  res.redirect('/task');
});

app.get("/task", function(req, res) {
  getNextTask(function(task, finished_tasks, num_tasks) {
    renderTemplate(template_file, task, function(e, data) {
      var out = "<!doctype html><html><body><form action=/submit method=post>\n";
      out += '<p>' + finished_tasks + ' / ' + num_tasks + '</p>\n';
      for (var k in task) {
        out += "<input type=hidden name='" + k + "' value=\"" + htmlEntities(task[k] || '') + "\" />";
      }
      out += data;
      out += '<hr/><input type=submit />\n';
      out += "</form></body></html>\n";

      res.send(out);
    });
  }, function() {
    res.send('DONE');
    if (program.quit_on_done) {
      process.exit(0);
    }
  });
});

app.post("/submit", function(req, res) {
  var task = req.body;
  writeCompletedTask(task, outputs_file, function(e) {
    if (e) {
      res.send('FAIL: ' + JSON.stringify(e));
    } else {
      console.log('Saved ' + JSON.stringify(task));
      res.redirect('/');
    }
  });
});

app.post("/delete-last", function(req, res) {
  deleteLastTask(outputs_file, function(e) {
    if (e) {
      res.send('FAIL: ' + JSON.stringify(e));
    } else {
      res.redirect('/');
    }
  })
});

app.listen(port);
console.log('Running local turk on http://localhost:' + port)
open('http://localhost:' + port + '/');
