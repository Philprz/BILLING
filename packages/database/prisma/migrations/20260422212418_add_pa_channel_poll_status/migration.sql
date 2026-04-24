-- AlterTable
ALTER TABLE "pa_channels" ADD COLUMN     "last_poll_at" TIMESTAMPTZ(6),
ADD COLUMN     "last_poll_error" TEXT;
