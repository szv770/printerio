import { Bricolage_Grotesque } from "next/font/google";

// Loaded only by the public home page (the app itself stays on Inter). A characterful grotesque for headlines.
export const displayFont = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap", weight: ["600", "700", "800"] });
