const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const compiler = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
let directory;
let fixture;

const fixtureSource = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal static class QuietPlacementFixture
{
    internal static IntPtr RootHandle;
    private delegate IntPtr WindowProcedure(IntPtr handle, uint message, IntPtr parameter, IntPtr value);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClass
    {
        public uint style;
        public WindowProcedure procedure;
        public int classExtra;
        public int windowExtra;
        public IntPtr instance;
        public IntPtr icon;
        public IntPtr cursor;
        public IntPtr background;
        public string menu;
        public string name;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClass(ref WindowClass windowClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowEx(int extendedStyle, string className, string title, int style, int left, int top, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProc(IntPtr handle, uint message, IntPtr parameter, IntPtr value);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr handle, int index);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool MoveWindow(IntPtr handle, int left, int top, int width, int height, bool repaint);
    private delegate bool EnumCallback(IntPtr handle, IntPtr parameter);

    internal static IntPtr CaptureForeground()
    {
        return mode.StartsWith("shield-") && mode != "shield-background" && !lostForeground ? RootHandle : IntPtr.Zero;
    }

    internal static Bitmap CaptureScreen(Rectangle bounds)
    {
        captureAttempts++;
        if (mode == "shield-capture-error") throw new InvalidOperationException("Simulated snapshot failure");
        if (!mode.StartsWith("shield-")) throw new InvalidOperationException("Capture unavailable in fixture");
        Bitmap image = new Bitmap(bounds.Width, bounds.Height);
        using (Graphics graphics = Graphics.FromImage(image)) graphics.Clear(Color.DarkSlateGray);
        return image;
    }

    private static int CountShields(out bool nonactivating)
    {
        int count = 0;
        bool valid = true;
        EnumWindows(delegate(IntPtr handle, IntPtr parameter)
        {
            if (GetWindow(handle, 4) == RootHandle && IsWindowVisible(handle))
            {
                count++;
                int style = GetWindowLong(handle, -20);
                valid = valid && (style & 0x08000000) != 0 && (style & 8) == 0;
            }
            return true;
        }, IntPtr.Zero);
        nonactivating = valid;
        return count;
    }

    private static readonly WindowProcedure procedure = HandleMessage;
    private static readonly Dictionary<IntPtr, int> disabled = new Dictionary<IntPtr, int>();
    private static readonly Dictionary<IntPtr, int> enabled = new Dictionary<IntPtr, int>();
    private static string mode;
    private static string session;
    private static IntPtr slowWindow;
    private static Process owner;
    private static bool focusPreserved = true;
    private static int shieldShows;
    private static bool lostForeground;
    private static int captureAttempts;
    private static bool snapshotPixelsCorrect = true;
    private static bool cursorHandled = true;
    private static bool cursorCopied = true;

    internal static IntPtr VerifyCursor(IntPtr handle)
    {
        cursorCopied = cursorCopied && handle != IntPtr.Zero && handle != Cursors.Cross.Handle;
        return IntPtr.Zero;
    }

    internal static void VerifyNonactivation(Action operation, bool showing)
    {
        IntPtr foreground = GetForegroundWindow();
        operation();
        focusPreserved = focusPreserved && GetForegroundWindow() == foreground;
        if (showing)
        {
            shieldShows++;
            foreach (Form form in Application.OpenForms)
            {
                if (GetWindow(form.Handle, 4) != RootHandle) continue;
                if (mode == "shield-cursor")
                {
                    MethodInfo handler = form.GetType().GetMethod("WndProc", BindingFlags.Instance | BindingFlags.NonPublic);
                    Message message = Message.Create(form.Handle, 0x20, form.Handle, new IntPtr(1));
                    object[] parameters = new object[] { message };
                    handler.Invoke(form, parameters);
                    cursorHandled = cursorHandled && ((Message)parameters[0]).Result == new IntPtr(1);
                }
                using (Bitmap image = new Bitmap(form.Width, form.Height))
                {
                    form.DrawToBitmap(image, new Rectangle(Point.Empty, image.Size));
                    snapshotPixelsCorrect = snapshotPixelsCorrect && image.GetPixel(0, 0).ToArgb() == Color.DarkSlateGray.ToArgb();
                }
            }
        }
    }

    private static IntPtr HandleMessage(IntPtr handle, uint message, IntPtr parameter, IntPtr value)
    {
        if (message == 11)
        {
            Dictionary<IntPtr, int> counts = parameter == IntPtr.Zero ? disabled : enabled;
            counts[handle] = Count(counts, handle) + 1;
            if (parameter == IntPtr.Zero)
            {
                if (mode == "cancel" || mode == "shield-cancel") File.WriteAllText(Path.Combine(session, "release"), "1");
                if ((mode == "owner-exit" || mode == "shield-owner-exit") && owner != null && !owner.HasExited) owner.Kill();
                if ((mode == "unresponsive" || mode == "shield-unresponsive") && handle == slowWindow) Thread.Sleep(250);
            }
        }
        return DefWindowProc(handle, message, parameter, value);
    }

    private static int Count(Dictionary<IntPtr, int> counts, IntPtr handle)
    {
        int count;
        return counts.TryGetValue(handle, out count) ? count : 0;
    }

    private static bool OwnVisible(IntPtr handle)
    {
        return (GetWindowLong(handle, -16) & 0x10000000) != 0;
    }

    private static IntPtr Create(string className, IntPtr parent, bool visible)
    {
        IntPtr handle = CreateWindowEx(0, className, "", 0x40000000 | (visible ? 0x10000000 : 0), 0, 0, 40, 40, parent, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (handle == IntPtr.Zero) throw new InvalidOperationException("Fixture window creation failed");
        return handle;
    }

    private sealed class Capture : StringWriter
    {
        public readonly ManualResetEvent ready = new ManualResetEvent(false);
        public readonly ManualResetEvent restored = new ManualResetEvent(false);
        public string status;
        public override void WriteLine(string line)
        {
            if (line.Contains("\"ready\":true")) { status = line; ready.Set(); }
            if (line.Contains("\"restored\":true")) restored.Set();
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        if (args[0] == "owner") { Thread.Sleep(30000); return 0; }
        mode = args[0];
        session = args[1];
        using (Form form = new Form())
        using (Capture capture = new Capture())
        {
            form.ShowInTaskbar = false;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new System.Drawing.Point(-20000, -20000);
            form.Size = new System.Drawing.Size(80, 80);
            form.Show();
            RootHandle = form.Handle;
            foreach (string className in new string[] { "OWL.Dock", "OWL.TabPane", "OWL.TabGroup", "OWL.Document", "PSViewC", "Quiet.Unrelated" })
            {
                WindowClass windowClass = new WindowClass();
                windowClass.procedure = procedure;
                windowClass.name = className;
                if (RegisterClass(ref windowClass) == 0) throw new InvalidOperationException("Fixture class registration failed");
            }
            IntPtr dock = Create("OWL.Dock", form.Handle, true);
            IntPtr pane = Create("OWL.TabPane", dock, true);
            IntPtr group = Create("OWL.TabGroup", pane, true);
            IntPtr activeDocument = Create("OWL.Document", group, true);
            IntPtr activeView = Create("PSViewC", activeDocument, true);
            IntPtr activeControl = Create("Quiet.Unrelated", activeView, true);
            IntPtr inactiveDocument = Create("OWL.Document", group, false);
            IntPtr inactiveView = Create("PSViewC", inactiveDocument, true);
            IntPtr hiddenControl = Create("Quiet.Unrelated", inactiveView, false);
            if (mode == "shield-multiple")
            {
                IntPtr secondDock = Create("OWL.Dock", form.Handle, true);
                IntPtr secondPane = Create("OWL.TabPane", secondDock, true);
                IntPtr secondGroup = Create("OWL.TabGroup", secondPane, true);
                Create("PSViewC", Create("OWL.Document", secondGroup, true), true);
            }
            IntPtr panel = Create("OWL.Dock", form.Handle, true);
            IntPtr unrelated = Create("PSViewC", panel, true);
            for (int index = 0; index < 600; index++) Create("Quiet.Unrelated", unrelated, true);
            Application.DoEvents();
            slowWindow = activeControl;
            int ownerId = Process.GetCurrentProcess().Id;
            if (mode == "owner-exit" || mode == "shield-owner-exit")
            {
                owner = Process.Start(new ProcessStartInfo(Assembly.GetExecutingAssembly().Location, "owner") { UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden });
                ownerId = owner.Id;
            }
            MethodInfo freeze = typeof(QuietPlacement).GetMethod("Freeze", BindingFlags.Static | BindingFlags.NonPublic);
            Exception failure = null;
            Stopwatch elapsed = Stopwatch.StartNew();
            Thread worker = new Thread(delegate()
            {
                try { freeze.Invoke(null, new object[] { ownerId, session, capture }); }
                catch (Exception error) { failure = error; }
            });
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
            try
            {
                while (!capture.ready.WaitOne(0) && worker.IsAlive && elapsed.ElapsedMilliseconds < 14000) { Application.DoEvents(); Thread.Sleep(1); }
                bool rootSuppressed = !OwnVisible(form.Handle);
                bool activeSuppressed = !OwnVisible(activeView);
                bool inactiveSuppressed = !OwnVisible(inactiveView);
                bool containersSuppressed = !OwnVisible(pane) && !OwnVisible(group);
                bool hiddenTouched = Count(disabled, activeDocument) != 0 || Count(disabled, inactiveDocument) != 0 || Count(disabled, hiddenControl) != 0;
                bool unrelatedTouched = Count(disabled, unrelated) != 0;
                int frozenCount = disabled.Count + (rootSuppressed ? 1 : 0);
                long startupMs = elapsed.ElapsedMilliseconds;
                bool nonactivating;
                int shieldsDuring = CountShields(out nonactivating);
                int shieldsAfterAction = shieldsDuring;
                bool lazyViewUnfrozen = false;
                if (capture.status != null && capture.status.Contains("\"frozen\":true"))
                {
                    ShowWindow(activeDocument, 0);
                    ShowWindow(inactiveDocument, 5);
                    if (mode == "shield-lazy") lazyViewUnfrozen = OwnVisible(Create("PSViewC", inactiveDocument, true));
                    Application.DoEvents();
                    inactiveSuppressed = inactiveSuppressed && !OwnVisible(inactiveView);
                    if (mode == "shield-move" || mode == "shield-background-switch")
                    {
                        if (mode == "shield-move") MoveWindow(dock, 0, 0, 10, 10, false);
                        else lostForeground = true;
                        Stopwatch hideWait = Stopwatch.StartNew();
                        while (hideWait.ElapsedMilliseconds < 1000)
                        {
                            Application.DoEvents();
                            bool ignoredState;
                            shieldsAfterAction = CountShields(out ignoredState);
                            if (shieldsAfterAction == 0) break;
                            Thread.Sleep(1);
                        }
                    }
                    ShowWindow(inactiveDocument, 0);
                    ShowWindow(activeDocument, 5);
                    if (mode != "watchdog" && mode != "shield-watchdog") File.WriteAllText(Path.Combine(session, "release"), "1");
                }
                while (worker.IsAlive && elapsed.ElapsedMilliseconds < 14000) { Application.DoEvents(); Thread.Sleep(1); }
                if (worker.IsAlive) throw new InvalidOperationException("Fixture helper did not restore within its watchdog");
                if (failure != null) throw failure;
                bool ignored;
                int shieldsAfter = CountShields(out ignored);
                Console.WriteLine("SHIELD " + "{\"during\":" + shieldsDuring + ",\"after\":" + shieldsAfter + ",\"afterAction\":" + shieldsAfterAction + ",\"shown\":" + shieldShows + ",\"captureAttempts\":" + captureAttempts + ",\"pixelsCorrect\":" + snapshotPixelsCorrect.ToString().ToLowerInvariant() + ",\"nonactivating\":" + nonactivating.ToString().ToLowerInvariant() + ",\"focusPreserved\":" + focusPreserved.ToString().ToLowerInvariant() + ",\"cursorHandled\":" + cursorHandled.ToString().ToLowerInvariant() + ",\"cursorCopied\":" + cursorCopied.ToString().ToLowerInvariant() + ",\"lazyViewUnfrozen\":" + lazyViewUnfrozen.ToString().ToLowerInvariant() + "}");
                Application.DoEvents();
                bool visibilityRestored = OwnVisible(form.Handle) && OwnVisible(dock) && OwnVisible(pane) && OwnVisible(group) && OwnVisible(activeDocument) && OwnVisible(activeView) && OwnVisible(activeControl) && OwnVisible(inactiveView) && !OwnVisible(inactiveDocument) && !OwnVisible(hiddenControl);
                bool singleFreeze = true;
                bool restoreDelivered = true;
                foreach (KeyValuePair<IntPtr, int> item in disabled)
                {
                    if (item.Value != 1) singleFreeze = false;
                    int restoreCount = Count(enabled, item.Key);
                    if (restoreCount < 1 || restoreCount > (mode == "unresponsive" ? 2 : 1)) restoreDelivered = false;
                }
                Console.WriteLine("{\"ready\":" + (capture.status ?? "null") + ",\"rootSuppressed\":" + rootSuppressed.ToString().ToLowerInvariant() + ",\"activeSuppressed\":" + activeSuppressed.ToString().ToLowerInvariant() + ",\"inactiveSuppressed\":" + inactiveSuppressed.ToString().ToLowerInvariant() + ",\"containersSuppressed\":" + containersSuppressed.ToString().ToLowerInvariant() + ",\"hiddenTouched\":" + hiddenTouched.ToString().ToLowerInvariant() + ",\"unrelatedTouched\":" + unrelatedTouched.ToString().ToLowerInvariant() + ",\"frozenCount\":" + frozenCount + ",\"startupMs\":" + startupMs + ",\"elapsedMs\":" + elapsed.ElapsedMilliseconds + ",\"restored\":" + capture.restored.WaitOne(0).ToString().ToLowerInvariant() + ",\"visibilityRestored\":" + visibilityRestored.ToString().ToLowerInvariant() + ",\"singleFreeze\":" + singleFreeze.ToString().ToLowerInvariant() + ",\"restoreDelivered\":" + restoreDelivered.ToString().ToLowerInvariant() + "}");
                return 0;
            }
            finally
            {
                File.WriteAllText(Path.Combine(session, "release"), "1");
                while (worker.IsAlive) { Application.DoEvents(); Thread.Sleep(1); }
                if (owner != null) { if (!owner.HasExited) owner.Kill(); owner.Dispose(); }
            }
        }
    }
}`;

test.before(() => {
  if (process.platform !== 'win32') return;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-aigc-subtree-test-'));
  fixture = path.join(directory, 'quiet-placement-fixture.exe');
  const source = fs.readFileSync(path.join(__dirname, '../tools/quiet-placement.cs'), 'utf8');
  const discovery = 'Process.GetProcessesByName("Photoshop")';
  assert.equal(source.split(discovery).length, 2);
  fs.writeFileSync(path.join(directory, 'quiet-placement.cs'), source.replace(discovery, 'new Process[] { Process.GetCurrentProcess() }').replaceAll('candidate.MainWindowHandle', 'QuietPlacementFixture.RootHandle').replaceAll('IntPtr foreground = GetForegroundWindow();', 'IntPtr foreground = QuietPlacementFixture.CaptureForeground();').replaceAll('GetForegroundWindow() != window', 'QuietPlacementFixture.CaptureForeground() != window').replaceAll('CaptureScreen(bounds)', 'QuietPlacementFixture.CaptureScreen(bounds)').replaceAll('SystemInformation.VirtualScreen', 'new System.Drawing.Rectangle(-30000, -30000, 60000, 60000)').replaceAll('shield.Show(new WindowOwner(window));', 'QuietPlacementFixture.VerifyNonactivation(delegate() { shield.Show(new WindowOwner(window)); }, true);').replaceAll('shield.Dispose();', 'QuietPlacementFixture.VerifyNonactivation(delegate() { shield.Dispose(); }, false);').replaceAll('GetCursorInfo(ref cursor) && (cursor.Flags & 1) != 0', '(cursor.Handle = Cursors.Cross.Handle) != IntPtr.Zero').replaceAll('SetCursor(cursorSnapshot);', 'QuietPlacementFixture.VerifyCursor(cursorSnapshot);'));
  fs.writeFileSync(path.join(directory, 'fixture.cs'), fixtureSource);
  const result = childProcess.spawnSync(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/main:QuietPlacementFixture', '/out:' + fixture, path.join(directory, 'quiet-placement.cs'), path.join(directory, 'fixture.cs')], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test.after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

function runFixture(mode) {
  const session = fs.mkdtempSync(path.join(directory, 'session-'));
  const result = childProcess.spawnSync(fixture, [mode, session], { windowsHide: true, encoding: 'utf8', timeout: 18000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = result.stdout.trim().split(/\r?\n/);
  const parsed = JSON.parse(output.at(-1));
  parsed.shield = JSON.parse(output.find(line => line.startsWith('SHIELD ')).slice(7));
  return parsed;
}

test('targeted native suppression covers nested and inactive document views without freezing unrelated subtrees', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture('coverage');
  assert.equal(result.ready.frozen, true, JSON.stringify(result));
  assert.equal(result.rootSuppressed, true);
  assert.equal(result.activeSuppressed, true, 'the nested active document view must receive WM_SETREDRAW');
  assert.equal(result.inactiveSuppressed, true, 'the initially hidden document view must remain suppressed when its document is selected');
  assert.equal(result.containersSuppressed, true);
  assert.equal(result.hiddenTouched, false);
  assert.equal(result.unrelatedTouched, false);
  assert.equal(result.frozenCount, 8);
  assert.ok(result.startupMs < 1500, JSON.stringify(result));
  assert.equal(result.restored, true);
  assert.equal(result.visibilityRestored, true);
  assert.equal(result.singleFreeze, true);
  assert.equal(result.restoreDelivered, true);
});

for (const mode of ['cancel', 'owner-exit', 'unresponsive']) {
  test(`native partial subtree suppression restores on ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const result = runFixture(mode);
    assert.equal(result.shield.shown, 0, JSON.stringify(result));
    assert.equal(result.ready.frozen, false, JSON.stringify(result));
    assert.equal(result.restored, true, JSON.stringify(result));
    assert.equal(result.visibilityRestored, true, JSON.stringify(result));
    assert.equal(result.singleFreeze, true, JSON.stringify(result));
    assert.equal(result.restoreDelivered, true, JSON.stringify(result));
  });
}

test('native watchdog restores a disposable document subtree without a release signal', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture('watchdog');
  assert.equal(result.ready.frozen, true, JSON.stringify(result));
  assert.ok(result.elapsedMs >= 10000 && result.elapsedMs < 14000, JSON.stringify(result));
  assert.equal(result.restored, true);
  assert.equal(result.visibilityRestored, true);
});

test('a nonactivating document snapshot shields a lazily created view until return completes', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture('shield-lazy');
  assert.equal(result.ready.frozen, true, JSON.stringify(result));
  assert.equal(result.shield.lazyViewUnfrozen, true, 'new views are not in the initial redraw snapshot');
  assert.equal(result.ready.shieldCount, 1, JSON.stringify(result));
  assert.equal(result.shield.during, 1, 'the owned snapshot must remain visible while the owner redraw is suppressed');
  assert.equal(result.shield.nonactivating, true);
  assert.equal(result.shield.pixelsCorrect, true);
  assert.equal(result.shield.focusPreserved, true);
  assert.equal(result.shield.after, 0);
  assert.equal(result.restored, true);
});

test('the document shield handles its own client cursor without global suppression', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture('shield-cursor');
  assert.equal(result.shield.shown, 1);
  assert.equal(result.shield.cursorHandled, true);
  assert.equal(result.shield.cursorCopied, true);
  assert.equal(result.shield.after, 0);
});

for (const mode of ['shield-cancel', 'shield-owner-exit', 'shield-unresponsive', 'shield-watchdog']) {
  test(`document snapshots are disposed on ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const result = runFixture(mode);
    assert.equal(result.shield.shown, 1, JSON.stringify(result));
    assert.equal(result.restored, true, JSON.stringify(result));
    assert.equal(result.shield.after, 0);
    assert.equal(result.shield.focusPreserved, true);
    assert.equal(result.visibilityRestored, true);
  });
}

for (const mode of ['shield-move', 'shield-background-switch']) {
  test(`the snapshot hides instead of obscuring a changed workspace on ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const result = runFixture(mode);
    assert.equal(result.shield.during, 1);
    assert.equal(result.shield.afterAction, 0);
    assert.equal(result.shield.after, 0);
    assert.equal(result.restored, true);
  });
}

test('separate document docks each get their own non-topmost snapshot', { skip: process.platform !== 'win32' }, () => {
  const result = runFixture('shield-multiple');
  assert.equal(result.ready.shieldCount, 2, JSON.stringify(result));
  assert.equal(result.shield.during, 2);
  assert.equal(result.shield.nonactivating, true);
  assert.equal(result.shield.pixelsCorrect, true);
  assert.equal(result.shield.after, 0);
});

for (const mode of ['shield-background', 'shield-capture-error']) {
  test(`snapshot unavailability preserves automatic placement fallback on ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const result = runFixture(mode);
    assert.equal(result.ready.frozen, true, JSON.stringify(result));
    assert.equal(result.shield.shown, 0);
    assert.equal(result.shield.captureAttempts, mode === 'shield-background' ? 0 : 1);
    assert.equal(result.shield.after, 0);
    assert.equal(result.restored, true);
  });
}
