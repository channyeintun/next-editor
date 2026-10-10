// driver.js with its stylesheet and the tour's dark theme over it. Imported
// only by startTour, when a tour actually starts, so none of them ships with
// the editor.
import "driver.js/dist/driver.css";
import "./productTour.css";

export { driver } from "driver.js";
