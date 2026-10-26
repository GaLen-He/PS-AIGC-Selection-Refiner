using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class QuietPlacement
{
    private const int LeaseTimeoutMs = 15000;
    private delegate bool EnumCallback(IntPtr handle, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr handle, uint command);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out NativeRectangle rectangle);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRectangle
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    private static IntPtr ForegroundWindow() { return GetForegroundWindow(); }

    private sealed class WindowOwner : IWin32Window
    {
        private readonly IntPtr handle;
        internal WindowOwner(IntPtr handle) { this.handle = handle; }
        public IntPtr Handle { get { return handle; } }
    }

    private sealed class WindowTarget
    {
        internal readonly IntPtr Handle;
        internal readonly IntPtr Root;
        internal readonly IntPtr Parent;
        internal readonly uint ProcessId;
        internal readonly uint ThreadId;
        internal readonly string ClassName;
        internal WindowTarget(IntPtr handle, IntPtr root)
        {
            Handle = handle;
            Root = root;
            Parent = GetParent(handle);
            ThreadId = GetWindowThreadProcessId(handle, out ProcessId);
            ClassName = WindowClass(handle);
        }
        internal bool IsCurrent()
        {
            uint processId;
            return IsWindow(Handle) && GetWindowThreadProcessId(Handle, out processId) == ThreadId && processId == ProcessId && GetParent(Handle) == Parent && WindowClass(Handle) == ClassName;
        }
    }

    private sealed class DocumentShield : Form
    {
        private readonly Bitmap image;
        internal readonly WindowTarget Target;
        internal readonly Rectangle CaptureBounds;
        internal DocumentShield(WindowTarget target, Rectangle bounds, Bitmap snapshot)
        {
            Target = target;
            CaptureBounds = bounds;
            image = snapshot;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            Bounds = bounds;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams parameters = base.CreateParams;
                parameters.ExStyle |= 0x08000080;
                return parameters;
            }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x21) { message.Result = new IntPtr(4); return; }
            base.WndProc(ref message);
        }
        protected override void OnPaint(PaintEventArgs args) { args.Graphics.DrawImageUnscaled(image, 0, 0); }
        protected override void OnPaintBackground(PaintEventArgs args) {}
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing) image.Dispose();
        }
    }

    private static string WindowClass(IntPtr handle)
    {
        StringBuilder name = new StringBuilder(256);
        GetClassName(handle, name, name.Capacity);
        return name.ToString();
    }
    private static Rectangle WindowBounds(IntPtr handle)
    {
        NativeRectangle bounds;
        if (!GetWindowRect(handle, out bounds)) return Rectangle.Empty;
        return Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
    }
    private static Rectangle CaptureBounds(WindowTarget target)
    {
        return Rectangle.Intersect(Rectangle.Intersect(WindowBounds(target.Handle), WindowBounds(target.Root)), SystemInformation.VirtualScreen);
    }
    private static bool IsUnobscured(WindowTarget target, Rectangle bounds, List<DocumentShield> shields)
    {
        HashSet<IntPtr> visited = new HashSet<IntPtr>();
        IntPtr above = GetWindow(target.Root, 3);
        while (above != IntPtr.Zero)
        {
            if (!visited.Add(above) || visited.Count > 1024 || !IsWindow(above)) return false;
            bool ownShield = false;
            foreach (DocumentShield shield in shields) { if (shield.IsHandleCreated && shield.Handle == above) { ownShield = true; break; } }
            if (!ownShield && IsWindowVisible(above) && bounds.IntersectsWith(WindowBounds(above))) return false;
            above = GetWindow(above, 3);
        }
        return true;
    }
    private static Bitmap CaptureScreen(Rectangle bounds)
    {
        Bitmap image = new Bitmap(bounds.Width, bounds.Height, PixelFormat.Format32bppPArgb);
        try
        {
            using (Graphics graphics = Graphics.FromImage(image)) graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size, CopyPixelOperation.SourceCopy);
            return image;
        }
        catch { image.Dispose(); throw; }
    }
    private static List<WindowTarget> SelectTargets(List<IntPtr> roots, uint photoshopId)
    {
        List<WindowTarget> targets = new List<WindowTarget>();
        HashSet<IntPtr> seen = new HashSet<IntPtr>();
        foreach (IntPtr root in roots)
        {
            EnumChildWindows(root, delegate(IntPtr handle, IntPtr data)
            {
                uint processId;
                GetWindowThreadProcessId(handle, out processId);
                if (processId != photoshopId || WindowClass(handle) != "OWL.Document" || !IsWindowVisible(handle)) return true;
                IntPtr container = handle;
                IntPtr parent = GetParent(handle);
                while (parent != IntPtr.Zero && parent != root)
                {
                    GetWindowThreadProcessId(parent, out processId);
                    if (processId != photoshopId) return true;
                    string name = WindowClass(parent);
                    if (name == "OWL.Dock" || name == "OWL.TabGroup") container = parent;
                    parent = GetParent(parent);
                }
                if (parent == root && seen.Add(container)) targets.Add(new WindowTarget(container, root));
                return true;
            }, IntPtr.Zero);
        }
        return targets;
    }
    private static bool OwnerAlive(int ownerId)
    {
        try { using (Process owner = Process.GetProcessById(ownerId)) { return !owner.HasExited; } }
        catch { return false; }
    }
    private static bool LeaseAlive(string heartbeat)
    {
        try { return File.Exists(heartbeat) && (DateTime.UtcNow - File.GetLastWriteTimeUtc(heartbeat)).TotalMilliseconds < LeaseTimeoutMs; }
        catch { return false; }
    }
    private static int NotProtected(TextWriter output, string reason)
    {
        output.WriteLine("{\"ready\":true,\"frozen\":false,\"reason\":\"" + reason + "\"}");
        output.Flush();
        return 0;
    }
    private static int ProtectWindows(List<IntPtr> roots, uint photoshopId, int ownerId, string session, TextWriter output)
    {
        List<DocumentShield> shields = new List<DocumentShield>();
        Stopwatch clock = Stopwatch.StartNew();
        string release = Path.Combine(session, "release");
        string heartbeat = Path.Combine(session, "heartbeat");
        try
        {
            if (File.Exists(release) || !OwnerAlive(ownerId) || !LeaseAlive(heartbeat)) return NotProtected(output, "cancelled");
            if (!roots.Contains(ForegroundWindow())) return NotProtected(output, "photoshop-not-foreground");
            List<WindowTarget> targets = SelectTargets(roots, photoshopId);
            List<IntPtr> documentRoots = new List<IntPtr>();
            foreach (WindowTarget target in targets) { if (!documentRoots.Contains(target.Root)) documentRoots.Add(target.Root); }
            if (!documentRoots.Contains(ForegroundWindow())) return NotProtected(output, "document-window-not-foreground");
            long pixelCount = 0;
            foreach (WindowTarget target in targets)
            {
                if (File.Exists(release) || !OwnerAlive(ownerId) || clock.ElapsedMilliseconds > 1500 || !documentRoots.Contains(ForegroundWindow())) return NotProtected(output, "cancelled-or-timeout");
                Rectangle bounds = CaptureBounds(target);
                long pixels = (long)bounds.Width * bounds.Height;
                if (!target.IsCurrent() || bounds.Width <= 0 || bounds.Height <= 0 || pixels > 16000000 || pixelCount + pixels > 32000000 || shields.Count >= 8 || !IsUnobscured(target, bounds, shields)) continue;
                Bitmap snapshot = null;
                DocumentShield shield = null;
                try
                {
                    snapshot = CaptureScreen(bounds);
                    shield = new DocumentShield(target, bounds, snapshot);
                    snapshot = null;
                    shields.Add(shield);
                    pixelCount += pixels;
                }
                catch
                {
                    if (shield != null) shield.Dispose();
                    if (snapshot != null) snapshot.Dispose();
                }
            }
            if (!shields.Count.Equals(targets.Count) || shields.Count == 0) return NotProtected(output, "incomplete-document-coverage");
            foreach (DocumentShield shield in shields)
            {
                if (File.Exists(release) || !shield.Target.IsCurrent() || clock.ElapsedMilliseconds > 1500 || !documentRoots.Contains(ForegroundWindow()) || !IsUnobscured(shield.Target, shield.CaptureBounds, shields)) return NotProtected(output, "window-changed");
                shield.Show(new WindowOwner(shield.Target.Root));
                shield.Update();
            }
            output.WriteLine("{\"ready\":true,\"frozen\":true,\"mode\":\"snapshot-only\",\"shieldCount\":" + shields.Count + "}");
            output.Flush();
            while (!File.Exists(release) && OwnerAlive(ownerId) && LeaseAlive(heartbeat) && clock.ElapsedMilliseconds < 600000)
            {
                Application.DoEvents();
                foreach (DocumentShield shield in shields)
                {
                    if (!shield.Target.IsCurrent() || !IsWindowVisible(shield.Target.Root) || CaptureBounds(shield.Target) != shield.CaptureBounds || !documentRoots.Contains(ForegroundWindow()) || !IsUnobscured(shield.Target, shield.CaptureBounds, shields)) shield.Hide();
                }
                Thread.Sleep(30);
            }
            if (File.Exists(release))
            {
                Stopwatch settling = Stopwatch.StartNew();
                while (settling.ElapsedMilliseconds < 100) { Application.DoEvents(); Thread.Sleep(10); }
            }
            return 0;
        }
        finally
        {
            foreach (DocumentShield shield in shields) { try { shield.Dispose(); } catch {} }
            output.WriteLine("{\"restored\":true}");
            output.Flush();
        }
    }
    private static int Protect(int ownerId, string session, TextWriter output)
    {
        uint photoshopId = 0;
        int instanceCount = 0;
        foreach (Process candidate in Process.GetProcessesByName("Photoshop"))
        {
            using (candidate)
            {
                if (candidate.MainWindowHandle == IntPtr.Zero) continue;
                photoshopId = (uint)candidate.Id;
                instanceCount++;
            }
        }
        if (instanceCount != 1) return NotProtected(output, "photoshop-instance-count");
        List<IntPtr> roots = new List<IntPtr>();
        EnumWindows(delegate(IntPtr handle, IntPtr data)
        {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (processId == photoshopId && IsWindowVisible(handle)) roots.Add(handle);
            return true;
        }, IntPtr.Zero);
        return ProtectWindows(roots, photoshopId, ownerId, session, output);
    }
    [STAThread]
    private static int Main(string[] args)
    {
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); }
        catch (EntryPointNotFoundException) { SetProcessDPIAware(); }
        using (StreamWriter output = new StreamWriter(Console.OpenStandardOutput()))
        {
            output.AutoFlush = true;
            try
            {
                if (args.Length != 4 || args[0] != "-OwnerPid" || args[2] != "-SessionDirectory") return 2;
                int ownerId;
                if (!int.TryParse(args[1], out ownerId) || ownerId <= 0) return 2;
                return Protect(ownerId, args[3], output);
            }
            catch { return NotProtected(output, "helper-error"); }
        }
    }
}
