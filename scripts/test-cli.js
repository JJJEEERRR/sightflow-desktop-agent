/* eslint-disable @typescript-eslint/no-require-imports
   --
   This is a CommonJS dev/test runner that loads the post-build CommonJS bundle at
   runtime. Converting to ESM would change Electron's entry-point handling. */
const { app } = require('electron')
const path = require('path')

app.whenReady().then(async () => {
  try {
    const action = process.argv[2]
    // Require the built module from out/main for its side effects (initializing
    // the main app window). We intentionally don't bind the export to a variable.
    require(path.join(__dirname, '../out/main/index.js'))
    console.log('[Test Runner] Running action:', action)
  } catch (err) {
    console.error(err)
  }
  app.quit()
})
