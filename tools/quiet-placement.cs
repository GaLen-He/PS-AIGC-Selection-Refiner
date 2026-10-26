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
    private delegate bool EnumCallback(IntPtr handle, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr handle);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] private static extern int GetWindowStyle(IntPtr handle, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr handle, uint message, UIntPtr parameter, IntPtr value, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr handle, uint message, UIntPtr parameter, IntPtr value);
    [DllImport("user32.dll")] private static extern bool RedrawWindow(IntPtr handle, IntPtr rectangle, IntPtr region, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out NativeRectangle rectangle);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool GetCursorInfo(ref NativeCursorInfo info);
    [DllImport("user32.dll")] private static extern IntPtr CopyIcon(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr SetCursor(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeCursorInfo
    {
        internal int Size;
        internal int Flags;
        internal IntPtr Handle;
        internal Point Position;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRectangle
    {
        internal int Left;
        internal int Top;
        internal int Right;
        internal int Bottom;
    }

    private sealed class WindowOwner : IWin32Window
    {
        private readonly IntPtr handle;
        internal WindowOwner(IntPtr handle) { this.handle = handle; }
        public IntPtr Handle { get { return handle; } }
    }

    private sealed class DocumentShield : Form
    {
        private readonly Bitmap image;
        private readonly IntPtr cursorSnapshot;
        internal readonly WindowTarget Target;
        internal readonly Rectangle CaptureBounds;

        internal DocumentShield(WindowTarget target, Rectangle bounds, Bitmap snapshot)
        {
            Target = target;
            CaptureBounds = bounds;
            image = snapshot;
            NativeCursorInfo cursor = new NativeCursorInfo();
            cursor.Size = Marshal.SizeOf(typeof(NativeCursorInfo));
            if (GetCursorInfo(ref cursor) && (cursor.Flags & 1) != 0) cursorSnapshot = CopyIcon(cursor.Handle);
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
            if (message.Msg == 0x20 && (message.LParam.ToInt64() & 0xffff) == 1)
            {
                if (cursorSnapshot != IntPtr.Zero) SetCursor(cursorSnapshot);
                message.Result = new IntPtr(1);
                return;
            }
            base.WndProc(ref message);
        }

        protected override void OnPaint(PaintEventArgs args) { args.Graphics.DrawImageUnscaled(image, 0, 0); }
        protected override void OnPaintBackground(PaintEventArgs args) {}
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            if (disposing)
            {
                image.Dispose();
                if (cursorSnapshot != IntPtr.Zero) DestroyIcon(cursorSnapshot);
            }
        }
    }

    private static Rectangle WindowBounds(IntPtr handle)
    {
        NativeRectangle bounds;
        if (!GetWindowRect(handle, out bounds)) return Rectangle.Empty;
        return Rectangle.FromLTRB(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
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

    private static void DisposeShields(List<DocumentShield> shields)
    {
        foreach (DocumentShield shield in shields) { try { shield.Dispose(); } catch {} }
        shields.Clear();
    }

    private static void CreateShields(IntPtr window, uint photoshopId, List<WindowTarget> targets, List<DocumentShield> shields, Stopwatch deadline, int ownerId, string releaseFile)
    {
        IntPtr foreground = GetForegroundWindow();
        if (foreground != window) return;
        HashSet<IntPtr> seen = new HashSet<IntPtr>();
        Rectangle rootBounds = WindowBounds(window);
        Rectangle screenBounds = SystemInformation.VirtualScreen;
        long pixelCount = 0;
        foreach (WindowTarget target in targets)
        {
            if (target.Parent != window || target.ClassName != "OWL.Dock") continue;
            bool documentDock = false;
            EnumChildWindows(target.Handle, delegate(IntPtr handle, IntPtr data)
            {
                WindowTarget child = new WindowTarget(handle);
                if (child.ProcessId == photoshopId && child.ClassName == "OWL.Document") documentDock = true;
                return true;
            }, IntPtr.Zero);
            if (!documentDock || !seen.Add(target.Handle)) continue;
            if (shields.Count >= 8 || deadline.ElapsedMilliseconds > 1500 || File.Exists(releaseFile) || !OwnerAlive(ownerId) || GetForegroundWindow() != window) break;
            Rectangle bounds = Rectangle.Intersect(Rectangle.Intersect(WindowBounds(target.Handle), rootBounds), screenBounds);
            if (bounds.Width <= 0 || bounds.Height <= 0) continue;
            long pixels = (long)bounds.Width * bounds.Height;
            if (pixels > 16000000 || pixelCount + pixels > 32000000) continue;
            Bitmap snapshot = null;
            DocumentShield shield = null;
            try
            {
                snapshot = CaptureScreen(bounds);
                shield = new DocumentShield(target, bounds, snapshot);
                snapshot = null;
                if (!target.IsCurrent() || GetForegroundWindow() != window || deadline.ElapsedMilliseconds > 1500 || File.Exists(releaseFile) || !OwnerAlive(ownerId)) { shield.Dispose(); break; }
                shield.Show(new WindowOwner(window));
                shield.Update();
                shields.Add(shield);
                pixelCount += pixels;
            }
            catch
            {
                if (shield != null) shield.Dispose();
                if (snapshot != null) snapshot.Dispose();
            }
        }
    }

    private static bool SetRedraw(IntPtr handle, bool enabled)
    {
        UIntPtr result;
        return SendMessageTimeout(handle, 11, new UIntPtr(enabled ? 1u : 0u), IntPtr.Zero, 2, 100, out result) != IntPtr.Zero;
    }

    private sealed class WindowTarget
    {
        internal readonly IntPtr Handle;
        internal readonly IntPtr Parent;
        internal readonly uint ProcessId;
        internal readonly uint ThreadId;
        internal readonly string ClassName;
        internal readonly bool OwnVisible;
        internal int Depth;

        internal WindowTarget(IntPtr handle)
        {
            Handle = handle;
            Parent = GetParent(handle);
            ThreadId = GetWindowThreadProcessId(handle, out ProcessId);
            StringBuilder name = new StringBuilder(256);
            GetClassName(handle, name, name.Capacity);
            ClassName = name.ToString();
            OwnVisible = (GetWindowStyle(handle, -16) & 0x10000000) != 0;
        }

        internal bool IsCurrent()
        {
            if (!IsWindow(Handle)) return false;
            uint processId;
            uint threadId = GetWindowThreadProcessId(Handle, out processId);
            StringBuilder name = new StringBuilder(256);
            GetClassName(Handle, name, name.Capacity);
            return processId == ProcessId && threadId == ThreadId && name.ToString() == ClassName;
        }
    }

    private static List<WindowTarget> SelectTargets(IntPtr window, uint photoshopId)
    {
        WindowTarget root = new WindowTarget(window);
        Dictionary<IntPtr, WindowTarget> children = new Dictionary<IntPtr, WindowTarget>();
        EnumChildWindows(window, delegate(IntPtr handle, IntPtr data)
        {
            children[handle] = new WindowTarget(handle);
            return true;
        }, IntPtr.Zero);
        Dictionary<IntPtr, WindowTarget> selected = new Dictionary<IntPtr, WindowTarget>();
        foreach (WindowTarget target in children.Values)
        {
            if (target.ProcessId == photoshopId && target.Parent == window && IsWindowVisible(target.Handle)) selected[target.Handle] = target;
            if (target.ClassName != "OWL.Document" || target.ProcessId != photoshopId || target.ThreadId != root.ThreadId) continue;
            List<WindowTarget> ancestry = new List<WindowTarget>();
            IntPtr parent = target.Parent;
            WindowTarget ancestor;
            while (parent != window && children.TryGetValue(parent, out ancestor))
            {
                if (ancestor.ProcessId != photoshopId || ancestor.ThreadId != root.ThreadId) break;
                ancestry.Add(ancestor);
                parent = ancestor.Parent;
            }
            if (parent != window || ancestry.Count == 0 || ancestry[0].ClassName != "OWL.TabGroup") continue;
            foreach (WindowTarget container in ancestry) if (container.OwnVisible) selected[container.Handle] = container;
            foreach (WindowTarget descendant in children.Values)
            {
                if (!descendant.OwnVisible || descendant.ProcessId != photoshopId || descendant.ThreadId != root.ThreadId || descendant.ClassName == "OWL.Document") continue;
                parent = descendant.Parent;
                while (parent != target.Handle && children.TryGetValue(parent, out ancestor))
                {
                    if (ancestor.ProcessId != photoshopId || ancestor.ThreadId != root.ThreadId) break;
                    parent = ancestor.Parent;
                }
                if (parent == target.Handle) selected[descendant.Handle] = descendant;
            }
        }
        selected[window] = root;
        List<WindowTarget> targets = new List<WindowTarget>(selected.Values);
        foreach (WindowTarget target in targets)
        {
            IntPtr parent = target.Parent;
            WindowTarget ancestor;
            while (children.TryGetValue(parent, out ancestor)) { target.Depth++; parent = ancestor.Parent; }
            if (target.Handle != window) target.Depth++;
        }
        targets.Sort(delegate(WindowTarget first, WindowTarget second) { return second.Depth.CompareTo(first.Depth); });
        return targets;
    }

    private static void Restore(List<WindowTarget> frozen, WindowTarget window)
    {
        foreach (WindowTarget target in frozen)
        {
            if (target.IsCurrent() && !SetRedraw(target.Handle, true)) PostMessage(target.Handle, 11, new UIntPtr(1u), IntPtr.Zero);
        }
        if (window != null && window.IsCurrent()) RedrawWindow(window.Handle, IntPtr.Zero, IntPtr.Zero, 1157);
    }

    private static bool OwnerAlive(int ownerId)
    {
        try { using (Process owner = Process.GetProcessById(ownerId)) { return !owner.HasExited; } }
        catch { return false; }
    }

    private static int Freeze(int ownerId, string directory, TextWriter output)
    {
        string releaseFile = Path.Combine(directory, "release");
        List<WindowTarget> frozen = new List<WindowTarget>();
        List<DocumentShield> shields = new List<DocumentShield>();
        IntPtr window = IntPtr.Zero;
        WindowTarget restoreWindow = null;
        Stopwatch deadline = Stopwatch.StartNew();
        try
        {
            if (!Directory.Exists(directory) || File.Exists(releaseFile) || !OwnerAlive(ownerId)) return NotFrozen(output, "cancelled");
            Process[] candidates = Process.GetProcessesByName("Photoshop");
            int instanceCount = 0;
            uint photoshopId = 0;
            foreach (Process candidate in candidates)
            {
                using (candidate)
                {
                    if (candidate.MainWindowHandle == IntPtr.Zero) continue;
                    window = candidate.MainWindowHandle;
                    photoshopId = (uint)candidate.Id;
                    instanceCount++;
                }
            }
            if (instanceCount != 1) return NotFrozen(output, "photoshop-instance-count");
            if (!IsWindowVisible(window)) return NotFrozen(output, "photoshop-window-not-visible");
            restoreWindow = new WindowTarget(window);
            List<WindowTarget> targets = SelectTargets(window, photoshopId);
            CreateShields(window, photoshopId, targets, shields, deadline, ownerId, releaseFile);
            foreach (WindowTarget target in targets)
            {
                if (File.Exists(releaseFile) || !OwnerAlive(ownerId) || deadline.ElapsedMilliseconds > 1500) return NotFrozen(output, "cancelled-or-timeout");
                if (!target.IsCurrent() || (GetWindowStyle(target.Handle, -16) & 0x10000000) == 0) return NotFrozen(output, "window-changed");
                frozen.Add(target);
                if (!SetRedraw(target.Handle, false)) return NotFrozen(output, "window-not-responding");
            }
            if (File.Exists(releaseFile) || !OwnerAlive(ownerId) || deadline.ElapsedMilliseconds > 1500) return NotFrozen(output, "cancelled-or-timeout");
            output.WriteLine("{\"ready\":true,\"frozen\":true,\"shieldCount\":" + shields.Count + "}");
            output.Flush();
            while (deadline.ElapsedMilliseconds < 10000 && !File.Exists(releaseFile) && OwnerAlive(ownerId))
            {
                Application.DoEvents();
                foreach (DocumentShield shield in shields)
                {
                    Rectangle bounds = Rectangle.Intersect(Rectangle.Intersect(WindowBounds(shield.Target.Handle), WindowBounds(window)), SystemInformation.VirtualScreen);
                    if (!shield.Target.IsCurrent() || bounds != shield.CaptureBounds || GetForegroundWindow() != window) shield.Hide();
                }
                Thread.Sleep(40);
            }
            return 0;
        }
        catch { return 1; }
        finally
        {
            try { Restore(frozen, restoreWindow); }
            finally { DisposeShields(shields); }
            output.WriteLine("{\"restored\":true}");
            output.Flush();
        }
    }

    private static int NotFrozen(TextWriter output, string reason)
    {
        output.WriteLine("{\"ready\":true,\"frozen\":false,\"reason\":\"" + reason + "\"}");
        output.Flush();
        return 0;
    }

    private static int SelfTest(TextWriter output)
    {
        using (Form form = new Form())
        {
            form.ShowInTaskbar = false;
            form.StartPosition = FormStartPosition.Manual;
            form.Location = new System.Drawing.Point(-20000, -20000);
            form.Size = new System.Drawing.Size(80, 80);
            form.Show();
            Application.DoEvents();
            IntPtr handle = form.Handle;
            WindowTarget restoreWindow = new WindowTarget(handle);
            try
            {
                if (!IsWindowVisible(handle) || !SetRedraw(handle, false) || IsWindowVisible(handle)) throw new InvalidOperationException("Suppression failed");
                if (!SetRedraw(handle, true) || !IsWindowVisible(handle)) throw new InvalidOperationException("Restoration failed");
                RedrawWindow(handle, IntPtr.Zero, IntPtr.Zero, 1157);
                output.WriteLine("Disposable window redraw suppression and restoration: PASS");
                return 0;
            }
            finally { Restore(new List<WindowTarget> { restoreWindow }, restoreWindow); }
        }
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
                if (args.Length == 1 && args[0] == "--self-test") return SelfTest(output);
                if (args.Length != 4 || args[0] != "-OwnerPid" || args[2] != "-SessionDirectory") return 2;
                int ownerId;
                if (!int.TryParse(args[1], out ownerId) || ownerId <= 0) return 2;
                return Freeze(ownerId, args[3], output);
            }
            catch (Exception error) { output.WriteLine(error.Message); return 1; }
        }
    }
}
