(function () {
  var fs = require("fs");
  var path = require("path");
  var os = require("os");
  var childProcess = require("child_process");

  function createGuard(options) {
    options = options || {};
    var platform = options.platform || process.platform;
    var spawn = options.spawn || childProcess.spawn;
    var tempRoot = options.tempRoot || os.tmpdir();
    var helperPath = options.helperPath || "";
    var startupTimeout = options.startupTimeoutMs || 1800;
    var releaseTimeout = options.releaseTimeoutMs || 11000;
    var activeRelease = null;
    var closing = false;

    function acquire() {
      if (platform !== "win32" || !helperPath || !fs.existsSync(helperPath)) return Promise.resolve(function () { return Promise.resolve(); });
      return new Promise(function (resolve) {
        var directory = "";
        var child = null;
        var settled = false;
        var timer = null;
        var output = "";
        var closed = false;
        var releasePromise = null;
        var releaseTimer = null;
        var resolveRelease = null;
        function release() {
          if (releasePromise) return releasePromise;
          releasePromise = new Promise(function (done) {
            try { if (directory && fs.existsSync(directory)) fs.writeFileSync(path.join(directory, "release"), "1"); } catch (error) {}
            if (closed) { done(); return; }
            resolveRelease = done;
            releaseTimer = setTimeout(done, releaseTimeout);
          });
          return releasePromise;
        }
        function finish(ready) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (ready) resolve(release);
          else release().then(function () { resolve(release); });
        }
        function cleanup() {
          if (!directory) return;
          try { fs.unlinkSync(path.join(directory, "release")); } catch (error) {}
          try { fs.rmdirSync(directory); } catch (error) {}
        }
        function restored() {
          closed = true;
          if (releaseTimer) clearTimeout(releaseTimer);
          if (resolveRelease) resolveRelease();
          cleanup();
        }
        try {
          directory = fs.mkdtempSync(path.join(tempRoot, "ps-aigc-redraw-"));
          activeRelease = release;
          child = spawn(helperPath, ["-OwnerPid", String(process.pid), "-SessionDirectory", directory],
          { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          child.stdout.on("data", function (chunk) {
            output += String(chunk);
            var newline;
            while ((newline = output.indexOf("\n")) >= 0) {
              var line = output.slice(0, newline);
              output = output.slice(newline + 1);
              try {
                var message = JSON.parse(line);
                if (message.restored) { restored(); finish(false); }
                else if (message.ready) finish(message.frozen === true);
              } catch (error) { finish(false); }
            }
          });
          child.stderr.on("data", function () {});
          child.on("error", function () {
            if (!child.pid) restored();
            finish(false);
          });
          child.on("close", function () { restored(); finish(false); });
          child.unref();
          timer = setTimeout(function () { finish(false); }, startupTimeout);
        } catch (error) {
          if (!child) restored();
          finish(false);
        }
      });
    }

    function run(operation) {
      return acquire().then(function (release) {
        activeRelease = release;
        return Promise.resolve().then(function () {
          if (closing) throw new Error("The plugin panel is closing.");
          return operation();
        }).then(function (result) {
          return release().then(function () {
            activeRelease = null;
            return result;
          });
        }, function (error) {
          return release().then(function () {
            activeRelease = null;
            throw error;
          });
        });
      });
    }

    function releaseActive() {
      closing = true;
      if (activeRelease) activeRelease();
    }

    return { run: run, releaseActive: releaseActive };
  }

  var api = { createGuard: createGuard };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.AIGCQuietPlacement = api;
}());
