import eye from '../../../design/reference/03_Brand_OracleEye_Simplified_Icon.png';

// The approved originals are shared with the design archive; never redraw the mark.
export function OracleEye({ className = '' }: { className?: string }) {
  return <img className={`oracle-eye ${className}`} src={eye} alt="神谕之眼" draggable={false}/>;
}
export function OracleLogo() {
  // Use the approved eye-only original with independent typography: the full
  // logo already contains the name and must not be layered with repeated words.
  return <div className="oracle-logo" role="img" aria-label="ORACULUM · 神谕">
    <img className="oracle-logo-eye" src={eye} alt="" draggable={false}/>
    <span className="oracle-logo-name" aria-hidden="true">ORACULUM</span>
    <span className="oracle-logo-cn" aria-hidden="true">神谕</span>
  </div>;
}
