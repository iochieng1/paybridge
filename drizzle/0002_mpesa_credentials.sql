CREATE TYPE "public"."mpesa_shortcode_type" AS ENUM('paybill', 'till');--> statement-breakpoint
CREATE TABLE "mpesa_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_id" uuid NOT NULL,
	"shortcode" text NOT NULL,
	"shortcode_type" "mpesa_shortcode_type" NOT NULL,
	"till_number" text,
	"consumer_key_encrypted" text NOT NULL,
	"consumer_secret_encrypted" text NOT NULL,
	"passkey_encrypted" text NOT NULL,
	"consumer_key_last4" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "mpesa_credentials_till_number" CHECK (("mpesa_credentials"."shortcode_type" = 'till') = ("mpesa_credentials"."till_number" is not null))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "mpesa_credentials_id" uuid;--> statement-breakpoint
ALTER TABLE "mpesa_credentials" ADD CONSTRAINT "mpesa_credentials_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mpesa_credentials_active_idx" ON "mpesa_credentials" USING btree ("merchant_id") WHERE "mpesa_credentials"."revoked_at" is null;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_mpesa_credentials_id_mpesa_credentials_id_fk" FOREIGN KEY ("mpesa_credentials_id") REFERENCES "public"."mpesa_credentials"("id") ON DELETE no action ON UPDATE no action;