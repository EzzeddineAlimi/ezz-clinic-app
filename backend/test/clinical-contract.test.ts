/* Nonclinical validation regression fixtures; synthetic codes and sites only. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isValidFdiTooth,validateClinicalSite,fdiToUniversalDisplay,canonicalDentalSurfaces} from '../src/contracts/clinical.ts';
test('FDI permanent and primary dental ranges',()=>{
 for(const v of [11,18,21,28,31,38,41,48,51,55,61,65,71,75,81,85])assert.equal(isValidFdiTooth(v),true);
 for(const v of [0,9,10,19,29,39,49,50,56,66,76,86,99,11.2])assert.equal(isValidFdiTooth(v),false);
});
test('FDI to Universal conversion is display-only',()=>{
 assert.deepEqual([18,28,38,48,55,65,75,85].map(fdiToUniversalDisplay),[1,16,17,32,'A','J','K','T']);
 assert.throws(()=>fdiToUniversalDisplay(99),RangeError);
});
test('Clinical site must be explicit, unambiguous and valid',()=>{
 assert.equal(validateClinicalSite({siteKind:'NONE'}),true);
 assert.equal(validateClinicalSite({siteKind:'TOOTH',toothFdi:36}),true);
 assert.equal(validateClinicalSite({siteKind:'AREA',areaCode:0}),true);
 assert.equal(validateClinicalSite({siteKind:'AREA',areaCode:30}),true);
 assert.equal(validateClinicalSite({siteKind:'AREA',areaCode:99}),false);
 assert.equal(validateClinicalSite({siteKind:'TOOTH',toothFdi:88}),false);
 assert.equal(validateClinicalSite({siteKind:'NONE',toothFdi:36} as never),false);
});
test('Surface normalization cannot silently accept anatomically invalid input',()=>{
 assert.equal(canonicalDentalSurfaces(36,'dom'),'MOD');
 assert.equal(canonicalDentalSurfaces(11,'dim'),'MID');
 assert.equal(canonicalDentalSurfaces(16,'pmod'),'MODP');
 for(const [tooth,value] of [[11,'O'],[36,'I'],[11,'B'],[36,'F'],[16,'L'],[36,'P'],[36,'MOO'],[36,'ABC'],[36,''],[99,'M']] as const)
  assert.throws(()=>canonicalDentalSurfaces(tooth,value),RangeError);
});