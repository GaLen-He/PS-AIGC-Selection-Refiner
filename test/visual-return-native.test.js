const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const extension = process.env.AIGC_RETURN_EXTENSION || path.join(__dirname, '../outputs/AIGCSelectionRefiner-0.5.18-package/AIGCSelectionRefiner');
const nativeSource = fs.readFileSync(path.join(extension, '../helper-source/quiet-placement.cs'), 'utf8');

test('automatic return never suppresses native visibility or activates a native window', () => {
  assert.doesNotMatch(nativeSource, /SetRedraw|WM_SETREDRAW|SetForegroundWindow|SetFocus\(|AttachThreadInput|LockWindowUpdate/);
  assert.match(nativeSource, /ShowWithoutActivation/);
  assert.match(nativeSource, /heartbeat/);
  assert.match(nativeSource, /EnumWindows/);
});

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

internal static class VisualReturnFixture
{
    internal static bool OwnerExists = true;
    internal static bool FailCapture;
    internal static int CaptureCount;
    internal static IntPtr Foreground;
    private delegate IntPtr WindowProcedure(IntPtr handle, uint message, IntPtr parameter, IntPtr value);
    private delegate bool EnumCallback(IntPtr handle, IntPtr data);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WindowClass
    {
        public uint style; public WindowProcedure procedure; public int classExtra; public int windowExtra;
        public IntPtr instance; public IntPtr icon; public IntPtr cursor; public IntPtr background;
        public string menu; public string name;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern ushort RegisterClass(ref WindowClass windowClass);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr CreateWindowEx(int extendedStyle, string className, string title, int style, int left, int top, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
    [DllImport("user32.dll")] private static extern IntPtr DefWindowProc(IntPtr handle, uint message, IntPtr parameter, IntPtr value);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr handle, int index);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    private static int redrawMessages;
    private static readonly WindowProcedure procedure = HandleMessage;
    private static IntPtr HandleMessage(IntPtr handle, uint message, IntPtr parameter, IntPtr value)
    {
        if (message == 11) redrawMessages++;
        return DefWindowProc(handle, message, parameter, value);
    }
    private sealed class RootWindow : Form
    {
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams { get { CreateParams result = base.CreateParams; result.ExStyle |= 0x08000080; return result; } }
    }
    private sealed class Output : StringWriter
    {
        internal volatile string Ready;
        internal volatile bool Restored;
        public override void WriteLine(string text)
        {
            if (text.Contains("\"ready\"")) Ready = text;
            if (text.Contains("\"restored\"")) Restored = true;
            base.WriteLine(text);
        }
    }
    private static IntPtr Child(string name, IntPtr parent, int left, bool visible)
    {
        return CreateWindowEx(0, name, "", unchecked((int)0x40000000) | (visible ? 0x10000000 : 0), left, 0, 140, 120, parent, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    }
    private static int Shields(List<IntPtr> roots, out bool nonactivating)
    {
        int count = 0; bool valid = true;
        EnumWindows(delegate(IntPtr handle, IntPtr data)
        {
            if (roots.Contains(GetWindow(handle, 4)) && IsWindowVisible(handle))
            {
                int style = GetWindowLong(handle, -20);
                valid = valid && (style & 0x08000000) != 0 && (style & 8) == 0;
                count++;
            }
            return true;
        }, IntPtr.Zero);
        nonactivating = valid;
        return count;
    }
    [STAThread]
    private static int Main(string[] args)
    {
        string mode = args[0]; string session = args[1];
        foreach (string name in new string[] { "OWL.Dock", "OWL.TabGroup", "OWL.Document", "Canvas", "Container" })
        {
            WindowClass windowClass = new WindowClass(); windowClass.name = name; windowClass.procedure = procedure; RegisterClass(ref windowClass);
        }
        using (RootWindow root = new RootWindow())
        using (RootWindow floating = new RootWindow())
        using (RootWindow dialog = new RootWindow())
        {
            IntPtr foregroundBefore = GetForegroundWindow();
            root.ShowInTaskbar = false; root.StartPosition = FormStartPosition.Manual; root.Bounds = new Rectangle(-22000, -22000, 400, 250); root.Show();
            floating.ShowInTaskbar = false; floating.StartPosition = FormStartPosition.Manual; floating.Bounds = new Rectangle(-21400, -22000, 200, 200); floating.Show();
            List<IntPtr> roots = new List<IntPtr> { root.Handle, floating.Handle };
            if (mode == "dialog") { dialog.ShowInTaskbar = false; dialog.StartPosition = FormStartPosition.Manual; dialog.Bounds = new Rectangle(-21000, -22000, 180, 180); dialog.Show(); roots.Add(dialog.Handle); }
            if (mode == "covered") { dialog.ShowInTaskbar = false; dialog.StartPosition = FormStartPosition.Manual; dialog.Bounds = floating.Bounds; dialog.Show(); }
            List<IntPtr> visible = new List<IntPtr> { root.Handle, floating.Handle };
            for (int index = 0; index < 2; index++)
            {
                IntPtr parent = root.Handle;
                if (mode == "nested") parent = Child("Container", root.Handle, index * 145, true);
                IntPtr dock = Child("OWL.Dock", parent, mode == "nested" ? 0 : index * 145, true);
                IntPtr tabs = Child("OWL.TabGroup", dock, 0, true);
                IntPtr document = Child("OWL.Document", tabs, 0, true);
                visible.Add(dock); visible.Add(tabs); visible.Add(document); visible.Add(Child("Canvas", document, 0, true));
            }
            IntPtr floatingTabs = Child("OWL.TabGroup", floating.Handle, 0, true);
            visible.Add(floatingTabs); visible.Add(Child("OWL.Document", floatingTabs, 0, true));
            IntPtr hidden = Child("OWL.Dock", root.Handle, 0, false);
            Child("OWL.Document", hidden, 0, true);
            Foreground = mode == "background" ? IntPtr.Zero : mode == "floating" ? floating.Handle : root.Handle;
            if (mode == "dialog") Foreground = dialog.Handle;
            FailCapture = mode == "capture-failure";
            Output output = new Output(); Exception failure = null;
            File.WriteAllText(Path.Combine(session, "heartbeat"), "start");
            if (mode == "cancelled") File.WriteAllText(Path.Combine(session, "release"), "1");
            Stopwatch clock = Stopwatch.StartNew();
            Thread worker = new Thread(delegate()
            {
                try
                {
                    typeof(QuietPlacement).GetMethod("ProtectWindows", BindingFlags.NonPublic | BindingFlags.Static).Invoke(null, new object[] { roots, (uint)Process.GetCurrentProcess().Id, Process.GetCurrentProcess().Id, session, output });
                }
                catch (Exception error) { failure = error; }
            });
            worker.SetApartmentState(ApartmentState.STA); worker.Start();
            int maxShields = 0; bool visiblePreserved = true; bool nonactivating = true; bool hiddenPreserved = true;
            bool observedReady = false; long readyAt = 0; int afterAltTab = -1;
            int lateShields = -1;
            int afterCover = -1;
            int coveredRootShields = -1;
            try
            {
                while (worker.IsAlive && clock.ElapsedMilliseconds < 16000)
                {
                    Application.DoEvents();
                    foreach (IntPtr handle in visible) visiblePreserved = visiblePreserved && IsWindowVisible(handle);
                    hiddenPreserved = hiddenPreserved && !IsWindowVisible(hidden);
                    bool valid; int count = Shields(roots, out valid); maxShields = Math.Max(maxShields, count); nonactivating = nonactivating && valid;
                    if (output.Ready != null && !observedReady) { observedReady = true; readyAt = clock.ElapsedMilliseconds; }
                    if (observedReady)
                    {
                        long sinceReady = clock.ElapsedMilliseconds - readyAt;
                        if (mode != "expired") File.WriteAllText(Path.Combine(session, "heartbeat"), sinceReady.ToString());
                        if (mode == "alt-tab" && sinceReady > 120) { Foreground = IntPtr.Zero; if (sinceReady > 260) afterAltTab = count; }
                        if (mode == "owner-loss" && sinceReady > 120) OwnerExists = false;
                        if (mode == "covered-later" && sinceReady > 120) { if (!dialog.Visible) { dialog.ShowInTaskbar = false; dialog.StartPosition = FormStartPosition.Manual; dialog.Bounds = floating.Bounds; dialog.Show(); } if (sinceReady > 260 && sinceReady < 350) { afterCover = count; coveredRootShields = Shields(new List<IntPtr> { floating.Handle }, out valid); } }
                        if (mode == "long" && sinceReady > 10500 && sinceReady < 11100) lateShields = count;
                        if (mode != "expired" && sinceReady > (mode == "long" ? 11200 : 400)) File.WriteAllText(Path.Combine(session, "release"), "1");
                    }
                    Thread.Sleep(15);
                }
            }
            finally
            {
                File.WriteAllText(Path.Combine(session, "release"), "1");
                while (worker.IsAlive) { Application.DoEvents(); Thread.Sleep(10); }
            }
            if (failure != null) { Console.WriteLine(failure); return 1; }
            bool ignored;
            Console.WriteLine("LATE_SHIELDS=" + lateShields);
            Console.WriteLine("AFTER_COVER=" + afterCover);
            Console.WriteLine("COVERED_ROOT_SHIELDS=" + coveredRootShields);
            Console.WriteLine("{\"ready\":" + (output.Ready ?? "null") + ",\"restored\":" + output.Restored.ToString().ToLowerInvariant() + ",\"maxShields\":" + maxShields + ",\"remaining\":" + Shields(roots, out ignored) + ",\"visiblePreserved\":" + visiblePreserved.ToString().ToLowerInvariant() + ",\"hiddenPreserved\":" + hiddenPreserved.ToString().ToLowerInvariant() + ",\"nonactivating\":" + nonactivating.ToString().ToLowerInvariant() + ",\"focusPreserved\":" + (foregroundBefore == GetForegroundWindow()).ToString().ToLowerInvariant() + ",\"redrawMessages\":" + redrawMessages + ",\"elapsedMs\":" + clock.ElapsedMilliseconds + ",\"afterAltTab\":" + afterAltTab + "}");
        }
        return 0;
    }
}
`;

let directory;
let executable;
test.before(() => {
  if (process.platform !== 'win32') return;
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aigc-visual-return-'));
  executable = path.join(directory, 'fixture.exe');
  const source = nativeSource
    .replace('return GetForegroundWindow();', 'return VisualReturnFixture.Foreground;')
    .replace('try { using (Process owner = Process.GetProcessById(ownerId))', 'if (!VisualReturnFixture.OwnerExists) return false; try { using (Process owner = Process.GetProcessById(ownerId))')
    .replace('Bitmap image = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppPArgb);', 'if (VisualReturnFixture.FailCapture && ++VisualReturnFixture.CaptureCount == 2) throw new InvalidOperationException("capture failed"); Bitmap image = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppPArgb);')
    .replace('graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);', 'graphics.Clear(Color.DarkSlateGray);')
    .replaceAll('SystemInformation.VirtualScreen', 'new Rectangle(-30000, -30000, 60000, 60000)')
    .replace('LeaseTimeoutMs = 15000', 'LeaseTimeoutMs = 700');
  fs.writeFileSync(path.join(directory, 'helper.cs'), source);
  fs.writeFileSync(path.join(directory, 'fixture.cs'), fixtureSource);
  const result = spawnSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/main:VisualReturnFixture', '/out:' + executable, path.join(directory, 'helper.cs'), path.join(directory, 'fixture.cs')], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
test.after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

for (const mode of ['tiled', 'nested', 'floating', 'long', 'expired', 'cancelled', 'background', 'alt-tab', 'owner-loss', 'capture-failure', 'dialog', 'covered', 'covered-later']) {
  test(`native visual return: ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const session = fs.mkdtempSync(path.join(directory, 'session-'));
    const run = spawnSync(executable, [mode, session], { windowsHide: true, encoding: 'utf8', timeout: 18000 });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const lines = run.stdout.trim().split(/\r?\n/);
    const result = JSON.parse(lines[lines.length - 1]);
    assert.equal(result.visiblePreserved, true);
    assert.equal(result.hiddenPreserved, true);
    assert.equal(result.nonactivating, true);
    assert.equal(result.focusPreserved, true);
    assert.equal(result.redrawMessages, 0);
    assert.equal(result.restored, true);
    assert.equal(result.remaining, 0);
    if (['cancelled', 'background', 'capture-failure', 'dialog', 'covered'].includes(mode)) assert.equal(result.maxShields, 0);
    else assert.equal(result.maxShields, 3);
    if (mode === 'long') { assert.ok(result.elapsedMs > 11000); assert.equal(lines[0], 'LATE_SHIELDS=3'); }
    if (mode === 'owner-loss') assert.ok(result.elapsedMs < 2000);
    if (mode === 'expired') assert.ok(result.elapsedMs < 4000);
    if (mode === 'alt-tab') assert.equal(result.afterAltTab, 0);
    if (mode === 'covered-later') { assert.match(lines[1], /^AFTER_COVER=[012]$/); assert.equal(lines[2], 'COVERED_ROOT_SHIELDS=0'); }
  });
}
