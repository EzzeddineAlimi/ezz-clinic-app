import { z } from "zod";

/** Administrative enquiry only — never a patient chart or clinical triage record. */
export const enquirySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  reason: z.string(),
  callback: z.string().nullable(),
  status: z.enum(["OPEN", "CLOSED"]),
  version: z.number().int().positive(),
  createdBy: z.string().uuid(),
  updatedBy: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const enquiryListSchema = z.object({
  enquiries: z.array(enquirySchema),
  nextBefore: z.string().uuid().nullable(),
});
export type Enquiry = z.infer<typeof enquirySchema>;
export type EnquiryStatus = Enquiry["status"];
