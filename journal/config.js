// Journal cloud settings. Journal gets its OWN Supabase project (not shared with other apps):
// its own account list, its own storage, its own transcription function and secrets.
// A publishable key is designed to be shipped publicly; row level security on the server decides
// what a signed-in user may read or write, and visitors who are not signed in get nothing.
// Leave both empty and the app runs fully on the device: no sign-in, no transcription, no cloud copy.
// If the project address changes, also change the connect-src entry of the
// Content-Security-Policy in index.html.
window.APP_CONFIG = window.APP_CONFIG || {
  supabaseUrl: '',
  supabaseKey: ''
};
