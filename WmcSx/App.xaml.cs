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

        private void OnEnteredBackground(object sender, EnteredBackgroundEventArgs e)
        {
            var deferral = e.GetDeferral();
            try
            {
                Log.Write("App: entered background");
                if (MainPage.Current != null) MainPage.Current.OnEnteredBackground();
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
