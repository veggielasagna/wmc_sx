using System;
using System.Threading.Tasks;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;
using WmcSx.Services;

namespace WmcSx
{
    sealed partial class App : Application
    {
        public App()
        {
            Log.Start();
            Log.Write("App: constructor");
            UnhandledException += OnUnhandledException;
            TaskScheduler.UnobservedTaskException += (s, e) =>
            {
                Log.Error("background task", e.Exception);
                e.SetObserved();
            };

            try
            {
                InitializeComponent();
                Log.Write("App: resources loaded");
            }
            catch (Exception ex)
            {
                Log.Error("App.InitializeComponent", ex);
                throw;
            }

            // Turn off Xbox "mouse mode" so the controller drives our own focus system.
            try
            {
                RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested;
            }
            catch (Exception ex)
            {
                Log.Error("RequiresPointerMode", ex);
            }
            EnteredBackground += OnEnteredBackground;
            LeavingBackground += OnLeavingBackground;
            Suspending += (s, e) => Log.Write("App: suspending, " + MainPage.MemoryText());
            Resuming += (s, e) => Log.Write("App: resuming");

            try
            {
                // The system warns before it lowers our memory limit (for example when a game
                // starts). Get under the new limit right away so the music isn't stopped.
                Windows.System.MemoryManager.AppMemoryUsageLimitChanging += (s, e) =>
                {
                    Log.Write("Memory limit changing: " + (e.OldLimit / 1048576) + " MB -> " + (e.NewLimit / 1048576) + " MB, " + MainPage.MemoryText());
                    if (e.NewLimit < e.OldLimit && MainPage.Current != null)
                    {
                        var page = MainPage.Current;
                        ulong newLimit = e.NewLimit;
                        var ignored = page.Dispatcher.RunAsync(Windows.UI.Core.CoreDispatcherPriority.High, () => page.OnMemoryLimitLowering(newLimit));
                    }
                };
                Windows.System.MemoryManager.AppMemoryUsageIncreased += (s, e) =>
                    Log.Write("Memory usage level now " + Windows.System.MemoryManager.AppMemoryUsageLevel + ", " + MainPage.MemoryText());
            }
            catch (Exception ex)
            {
                Log.Error("memory events", ex);
            }
        }

        private void OnUnhandledException(object sender, Windows.UI.Xaml.UnhandledExceptionEventArgs e)
        {
            Log.Error("unhandled", e.Exception);
            Log.Write("Unhandled message: " + e.Message);
            // Stay open so the error can be shown and read instead of closing.
            e.Handled = true;
            if (MainPage.Current != null) MainPage.Current.ShowError(e.Message);
        }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
        {
            Log.Write("App: launched");
            try
            {
                // Draw edge to edge; the interface keeps its own TV-safe margins.
                ApplicationView.GetForCurrentView().SetDesiredBoundsMode(ApplicationViewBoundsMode.UseCoreWindow);

                var rootFrame = Window.Current.Content as Frame;
                if (rootFrame == null)
                {
                    rootFrame = new Frame();
                    Window.Current.Content = rootFrame;
                }
                if (rootFrame.Content == null)
                {
                    Log.Write("App: opening main page");
                    rootFrame.Navigate(typeof(MainPage), e.Arguments);
                }
                Window.Current.Activate();
                Log.Write("App: window activated");
            }
            catch (Exception ex)
            {
                Log.Error("OnLaunched", ex);
                throw;
            }
        }

        private async void OnEnteredBackground(object sender, EnteredBackgroundEventArgs e)
        {
            var deferral = e.GetDeferral();
            try
            {
                Log.Write("App: entered background");
                if (MainPage.Current != null) await MainPage.Current.OnEnteredBackgroundAsync();
            }
            catch (Exception ex)
            {
                Log.Error("EnteredBackground", ex);
            }
            finally
            {
                deferral.Complete();
            }
        }

        private void OnLeavingBackground(object sender, LeavingBackgroundEventArgs e)
        {
            var deferral = e.GetDeferral();
            try
            {
                Log.Write("App: leaving background");
                if (MainPage.Current != null) MainPage.Current.OnLeavingBackground();
            }
            catch (Exception ex)
            {
                Log.Error("LeavingBackground", ex);
            }
            finally
            {
                deferral.Complete();
            }
        }
    }
}
