import gradient from "gradient-string";

import { getUserPkgManager } from "./getUserPkgManager.js";

// colors brought in from vscode poimandres theme
const poimandresTheme = {
  blue: "#add7ff",
  cyan: "#89ddff",
  green: "#5de4c7",
  magenta: "#fae4fc",
  red: "#d0679d",
  yellow: "#fffac2",
};

const TITLE_TEXT = `
                                      _            
                                     | |           
   ___ ___  _ __ ___  _ __   __ _  __| | ___ _ __  
  / __/ _ \\| '_ \` _  \| '_ \\ / _\` |/ _\` |/ __| '_ \\ 
 | (_| (_) | | | | | | |_) | (_| | (_| | (__| | | |
  \\___\\___/|_| |_| |_| .__/ \\__,_|\\__,_|\\___|_| |_|
                     | |                           
                     |_|                           
`;

export const renderTitle = () => {
  const t3Gradient = gradient(Object.values(poimandresTheme));

  // resolves weird behavior where the ascii is offset
  const pkgManager = getUserPkgManager();
  if (pkgManager === "yarn" || pkgManager === "pnpm") {
    console.log("");
  }
  console.log(t3Gradient.multiline(TITLE_TEXT));
};
