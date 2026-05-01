# Cookies export guide

This app can read cookies from a `cookies.txt` file when a platform requires authentication.

## Export a cookies.txt file

Use a browser extension that exports cookies in the Netscape format (for example, "Get cookies.txt" or similar).

Steps:

1. Log in to the platform in your browser.
2. Open the extension and export cookies for the site.
3. Save the file as `cookies.txt`.

## Use the cookies file locally

Set the environment variable to the full path:

```text
AVD_COOKIES_PATH=C:\\path\\to\\cookies.txt
```

Then restart the server.

## Use the cookies file on Render

Upload `cookies.txt` using Render's "Secret Files" feature and set `AVD_COOKIES_PATH` to the secret file path.
If you are unsure about the path, paste the secret file path value directly in the env var.

Security notes:

- Treat cookies like passwords. Do not commit them to git.
- Rotate the cookies if you share them accidentally.
