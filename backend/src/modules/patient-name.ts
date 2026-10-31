/**
 * SQL-only canonical name key for patient lookup and identity warnings.
 * The argument must be a trusted SQL expression from source code, NEVER user input.
 * PostgreSQL expressions and query parameters use the identical folding rules.
 * Remove Arabic marks/tatweel and combining Latin accents; fold common
 * French accents and Arabic alef, taa marbuta and final yaa variants.
 * This is a search/possible-duplicate hint, never proof of identity.
 */
export function patientNameKeySql(expression: string): string {
  return `translate(
    regexp_replace(lower(${expression}), '[̀-ًͯ-ٰٟـ]', '', 'g'),
    'àáâãäåçèéêëìíîïñòóôõöùúûüýÿأإآٱةى',
    'aaaaaaceeeeiiiinooooouuuuyyااااهي'
  )`;
}
