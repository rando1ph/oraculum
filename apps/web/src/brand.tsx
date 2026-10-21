import eye from '../../../design/reference/03_Brand_OracleEye_Simplified_Icon.png';
import logo from '../../../design/reference/01_Brand_OracleEye_Full_Logo.png';

// The approved originals are shared with the design archive; never redraw the mark.
export function OracleEye({ className = '' }: { className?: string }) {
  return <img className={`oracle-eye ${className}`} src={eye} alt="神谕之眼" draggable={false}/>;
}
export function OracleLogo() {
  return <img className="oracle-logo" src={logo} alt="Oraculum · 神谕" draggable={false}/>;
}
