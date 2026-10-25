using System;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.UI.ViewManagement;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace WmcSx
{
    sealed partial class App : Application
    {
        public App()
        {
            InitializeComponent();
            // Turn off Xbox "mouse mode" so the controller drives our own focus system.
            RequiresPointerMode = ApplicationRequiresPointerMode.WhenRequested;
            EnteredBackground += OnEnteredBackground;
            LeavingBackground += OnLeavingBackground;
        }

        protected override void OnLaunched(LaunchActivatedEventArgs e)
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
                rootFrame.Navigate(typeof(MainPage), e.Arguments);
            }
            Window.Current.Activate();
        }

        private void OnEnteredBackground(object sender, EnteredBackgroundEventArgs e)
        {
            var deferral = e.GetDeferral();
            try
            {
                if (MainPage.Current != null) MainPage.Current.OnEnteredBackground();
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
                if (MainPage.Current != null) MainPage.Current.OnLeavingBackground();
            }
            finally
            {
                deferral.Complete();
            }
        }
    }
}
