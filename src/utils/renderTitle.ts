import gradient from "gradient-string";
import { packageInfo } from "../lib/packageInfo.js";

export const renderTitle = () => {
  console.log(
    gradient(["#add7ff", "#89ddff", "#5de4c7"])(
      `${packageInfo.name} v${packageInfo.version}`
    )
  );
};
