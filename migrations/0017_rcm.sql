-- GST under reverse charge on a foreign OTA's commission (import of services): Booking.com B.V. invoices its
-- commission and payment charge from the Netherlands without GST, and the hotel pays 18% IGST on it itself.
-- It does not change the payout (nothing extra is deducted); it is shown on the GST filing sheet.
ALTER TABLE channels ADD COLUMN commission_rcm_bp INTEGER NOT NULL DEFAULT 0;
UPDATE channels SET commission_rcm_bp = 1800 WHERE code IN ('booking_com', 'booking_com_hotel_collect');
