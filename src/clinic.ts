/* FICTIONAL DATA ONLY. This prototype has NO authentication, database, or protected audit store. */
export type Patient = { id: string; name: string; phone: string };
export type Appointment = { id: string; patientId: string; startsAt: string; treatment?: string; feeMillimes?: number; confirmed: boolean };
export type Payment = { id: string; appointmentId: string; amountMillimes: number; method: 'cash' | 'card'; receiptNo: number };
export type CashCount = { id: string; countedMillimes: number; expectedMillimes: number; differenceMillimes: number };
export type Event = { id: string; action: string; detail: string };

export class Clinic {
  private serial = 0;
  private receiptSerial = 0;
  patients: Patient[] = [];
  appointments: Appointment[] = [];
  payments: Payment[] = [];
  counts: CashCount[] = [];
  events: Event[] = [];

  private id(prefix: string): string { this.serial += 1; return `${prefix}-${this.serial}`; }
  private log(action: string, detail: string): void { this.events.push({ id: this.id('ev'), action, detail }); }

  addPatient(name: string, phone: string): Patient {
    if (!name.trim()) throw new Error('Patient name required');
    const patient = { id: this.id('pt'), name: name.trim(), phone: phone.trim() };
    this.patients.push(patient);
    this.log('patient_created', patient.id);
    return patient;
  }

  addAppointment(patientId: string, startsAt: string): Appointment {
    if (!this.patients.some(p => p.id === patientId)) throw new Error('Unknown patient');
    if (!startsAt.trim()) throw new Error('Appointment date required');
    const appt = { id: this.id('ap'), patientId, startsAt, confirmed: false };
    this.appointments.push(appt);
    this.log('appointment_created', appt.id);
    return appt;
  }

  confirmCare(appointmentId: string, treatment: string, feeMillimes: number): Appointment {
    const appt = this.appointments.find(a => a.id === appointmentId);
    if (!appt) throw new Error('Unknown appointment');
    if (appt.confirmed) throw new Error('Care already confirmed');
    if (!treatment.trim() || !Number.isSafeInteger(feeMillimes) || feeMillimes <= 0) throw new Error('Valid treatment and fee required');
    appt.treatment = treatment.trim();
    appt.feeMillimes = feeMillimes;
    appt.confirmed = true;
    this.log('care_confirmed', `${appt.id}, ${feeMillimes} millimes`);
    return appt;
  }

  balance(appointmentId: string): number {
    const appt = this.appointments.find(a => a.id === appointmentId);
    if (!appt || !appt.confirmed || appt.feeMillimes === undefined) throw new Error('Care not confirmed');
    return appt.feeMillimes - this.payments.filter(p => p.appointmentId === appointmentId).reduce((sum, p) => sum + p.amountMillimes, 0);
  }

  pay(appointmentId: string, amountMillimes: number, method: Payment['method']): Payment {
    const balance = this.balance(appointmentId);
    if (!Number.isSafeInteger(amountMillimes) || amountMillimes <= 0 || amountMillimes > balance) throw new Error('Payment must be positive and not exceed balance');
    if (method !== 'cash' && method !== 'card') throw new Error('Invalid payment method');
    this.receiptSerial += 1;
    const p = { id: this.id('pay'), appointmentId, amountMillimes, method, receiptNo: this.receiptSerial };
    this.payments.push(p);
    this.log('payment_recorded', `Receipt #${p.receiptNo}; ${method}; ${amountMillimes} millimes`);
    return p;
  }

  countCash(countedMillimes: number): CashCount {
    if (!Number.isSafeInteger(countedMillimes) || countedMillimes < 0) throw new Error('Cash count cannot be negative');
    const expectedMillimes = this.payments.filter(p => p.method === 'cash').reduce((sum,p) => sum + p.amountMillimes,0);
    const result = { id:this.id('count'), countedMillimes, expectedMillimes, differenceMillimes:countedMillimes-expectedMillimes };
    this.counts.push(result);
    this.log('cash_count', `${result.id}: difference ${result.differenceMillimes} millimes`);
    return result;
  }

  snapshot() {
    return { patients:this.patients, appointments:this.appointments, payments:this.payments,
      counts:this.counts, events:this.events,
      openBalances:this.appointments.filter(a=>a.confirmed).map(a=>({appointmentId:a.id,balanceMillimes:this.balance(a.id)})) };
  }
}
