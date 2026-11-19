import { Check } from "lucide-react";
import styles from "./landing-page.module.css";

/**
 * A still picture for the hero: a phone showing the normal Print dialog with the school printer chosen, and the
 * stapled page that comes out. Pure CSS, decorative (the live demo further down is the interactive version).
 */
export function HeroPhone() {
  return (
    <div className={styles.heroArt} role="img" aria-label="A phone showing the Print menu with the school printer chosen, and a stapled page coming out">
      <div className={styles.artDots} aria-hidden="true" />
      <div className={styles.phone} aria-hidden="true">
        <div className={styles.phoneNotch} />
        <div className={styles.phoneScreen}>
          <div className={styles.dlgBar}>
            <span>Cancel</span>
            <strong>Print</strong>
            <span />
          </div>
          <div className={styles.dlgDoc}>
            <i /><i /><i /><i /><i />
          </div>
          <div className={styles.dlgRows}>
            <div><span>Printer</span><strong>Printio-MLMI-SZV</strong></div>
            <div><span>Sides</span><strong>Double-sided</strong></div>
            <div><span>Finish</span><strong>Staple</strong></div>
          </div>
          <div className={styles.dlgBtn}>Print</div>
        </div>
      </div>
      <div className={styles.outPage} aria-hidden="true">
        <span className={styles.outStaple} />
        <div className={styles.outLines}><i /><i /><i /><i /><i /><i /></div>
        <span className={styles.outStamp}>SZV</span>
      </div>
      <div className={styles.badge} aria-hidden="true">
        <Check className="h-4 w-4" />
        Printed and stapled
      </div>
    </div>
  );
}
