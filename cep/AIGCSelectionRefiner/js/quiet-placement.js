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
    var releaseTimeout = options.releaseTimeoutMs || 19000;
    var terminationTimeout = options.terminationTimeoutMs || 2000;
    var heartbeatInterval = options.heartbeatIntervalMs || 1000;
    var activeRelease = null;
    var closing = false;
    var protectionBlocked = false;

    function acquire() {
      if (protectionBlocked) return Promise.reject(new Error("上一条回填的窗口保护尚未释放，已暂停新的回填，请稍后重试。"));
      if (platform !== "win32" || !helperPath || !fs.existsSync(helperPath)) return Promise.resolve(function () { return Promise.resolve(); });
      return new Promise(function (resolve, reject) {
        var directory = "";
        var child = null;
        var settled = false;
        var timer = null;
        var output = "";
        var closed = false;
        var releasePromise = null;
        var releaseTimer = null;
        var resolveRelease = null;
        var heartbeatTimer = null;
        function stopHeartbeat() {
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        function heartbeat() {
          try { fs.writeFileSync(path.join(directory, "heartbeat"), String(Date.now())); } catch (error) {}
        }
        function release() {
          if (releasePromise) return releasePromise;
          stopHeartbeat();
          releasePromise = new Promise(function (done, fail) {
            try { if (directory && fs.existsSync(directory)) fs.writeFileSync(path.join(directory, "release"), "1"); } catch (error) {}
            if (closed) { done(); return; }
            resolveRelease = done;
            releaseTimer = setTimeout(function () {
              if (closed || !child || !child.pid) { done(); return; }
              try { child.kill(); } catch (error) {}
              if (closed) { done(); return; }
              releaseTimer = setTimeout(function () {
                if (closed) { done(); return; }
                protectionBlocked = true;
                fail(new Error("回填窗口保护未能释放，结果已保留，请稍后重试取回。"));
              }, terminationTimeout);
            }, releaseTimeout);
          });
          return releasePromise;
        }
        function finish(ready) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (ready) resolve(release);
          else release().then(function () { resolve(release); }, reject);
        }
        function cleanup() {
          if (!directory) return;
          try { fs.unlinkSync(path.join(directory, "heartbeat")); } catch (error) {}
          try { fs.unlinkSync(path.join(directory, "release")); } catch (error) {}
          try { fs.rmdirSync(directory); } catch (error) {}
        }
        function restored() {
          if (closed) return;
          stopHeartbeat();
          protectionBlocked = false;
          closed = true;
          if (releaseTimer) clearTimeout(releaseTimer);
          if (resolveRelease) resolveRelease();
          cleanup();
        }
        try {
          directory = fs.mkdtempSync(path.join(tempRoot, "ps-aigc-redraw-"));
          heartbeat();
          heartbeatTimer = setInterval(heartbeat, heartbeatInterval);
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
          child.on("exit", function () { restored(); finish(false); });
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
      if (activeRelease) activeRelease().catch(function () {});
    }

    return { run: run, releaseActive: releaseActive };
  }

  var api = { createGuard: createGuard };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.AIGCQuietPlacement = api;
}());
