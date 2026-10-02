CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS bookings_no_overlap;
ALTER TABLE "Booking" ADD CONSTRAINT bookings_no_overlap
  EXCLUDE USING gist ("resourceId" WITH =, tstzrange("startTime","endTime",'[)') WITH &&)
  WHERE ("status" IN ('PENDING','APPROVED'));
ALTER TABLE "Booking" DROP CONSTRAINT IF EXISTS bookings_time_order;
ALTER TABLE "Booking" ADD CONSTRAINT bookings_time_order CHECK ("endTime" > "startTime");
