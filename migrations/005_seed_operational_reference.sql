INSERT INTO processors (code, name, supports_api_representment) VALUES
  ('STRIPE','Stripe',true),
  ('CHECKOUT_COM','Checkout.com',true),
  ('MYFATOORAH','MyFatoorah',false),
  ('NOWPAYMENTS','NOWPayments',false),
  ('FORUMPAY','ForumPay',false);

INSERT INTO avs_results (code, meaning, match_level) VALUES
  ('Y','Street address and 5-digit ZIP match','FULL'),
  ('X','Street address and 9-digit ZIP match','FULL'),
  ('W','9-digit ZIP matches, street address does not','PARTIAL'),
  ('Z','5-digit ZIP matches, street address does not','PARTIAL'),
  ('A','Street address matches, ZIP does not','PARTIAL'),
  ('G','Non-US card issuer','UNAVAILABLE'),
  ('N','No match on street address or ZIP','NONE'),
  ('R','Retry: system unavailable or timed out','UNAVAILABLE'),
  ('U','Address unavailable or issuer does not support AVS','UNAVAILABLE');

INSERT INTO evidence_kinds (code, name, description) VALUES
  ('PROOF_OF_SHIPPING','Proof of shipping','Tracking number, shipping receipt or carrier manifest.'),
  ('PROOF_OF_DELIVERY','Proof of delivery','Delivery confirmation, signature or carrier proof of receipt.'),
  ('TRANSACTION_RECEIPT','Transaction receipt','Sales or order receipt showing items, amount and date.'),
  ('AVS_RESPONSE','AVS response','Address verification result recorded at authorisation.'),
  ('CVV_RESPONSE','CVV response','Card verification value result recorded at authorisation.'),
  ('THREE_DS_RECORD','3-D Secure record','Authentication result and liability shift evidence.'),
  ('ADDRESS_MATCH','Billing and shipping match','Evidence that bill-to and ship-to addresses agree.'),
  ('CUSTOMER_COMMUNICATION','Customer communication','Emails, chat logs or call notes with the cardholder.'),
  ('TERMS_ACCEPTED','Terms accepted','Refund, cancellation or subscription terms the customer agreed to.'),
  ('REFUND_RECORD','Refund record','Proof a credit was issued, with date and amount.'),
  ('AUTHORIZATION_RECORD','Authorization record','Approval code and timestamp from the issuer.'),
  ('PRIOR_TRANSACTION_HISTORY','Prior transaction history','Earlier undisputed purchases by the same cardholder.'),
  ('DIGITAL_ACCESS_LOG','Digital access log','Login, download or usage records proving the service was used.'),
  ('PRODUCT_DESCRIPTION','Product description','Listing as shown to the customer at time of purchase.');

-- Requirements for the highest-volume reason codes.
INSERT INTO evidence_requirements (reason_code_id, evidence_kind_code, requirement)
SELECT rc.id, v.kind, v.req
FROM (VALUES
  ('VISA','10.4','AVS_RESPONSE','REQUIRED'),
  ('VISA','10.4','CVV_RESPONSE','REQUIRED'),
  ('VISA','10.4','THREE_DS_RECORD','RECOMMENDED'),
  ('VISA','10.4','PRIOR_TRANSACTION_HISTORY','RECOMMENDED'),
  ('VISA','10.4','PROOF_OF_DELIVERY','RECOMMENDED'),
  ('VISA','10.4','ADDRESS_MATCH','OPTIONAL'),
  ('VISA','13.1','PROOF_OF_DELIVERY','REQUIRED'),
  ('VISA','13.1','PROOF_OF_SHIPPING','REQUIRED'),
  ('VISA','13.1','DIGITAL_ACCESS_LOG','RECOMMENDED'),
  ('VISA','13.1','CUSTOMER_COMMUNICATION','OPTIONAL'),
  ('VISA','13.3','PRODUCT_DESCRIPTION','REQUIRED'),
  ('VISA','13.3','CUSTOMER_COMMUNICATION','RECOMMENDED'),
  ('VISA','13.3','TERMS_ACCEPTED','RECOMMENDED'),
  ('VISA','13.6','REFUND_RECORD','REQUIRED'),
  ('VISA','13.6','TERMS_ACCEPTED','RECOMMENDED'),
  ('VISA','13.2','TERMS_ACCEPTED','REQUIRED'),
  ('VISA','13.2','CUSTOMER_COMMUNICATION','RECOMMENDED'),
  ('VISA','11.3','AUTHORIZATION_RECORD','REQUIRED'),
  ('MASTERCARD','4837','AVS_RESPONSE','REQUIRED'),
  ('MASTERCARD','4837','CVV_RESPONSE','REQUIRED'),
  ('MASTERCARD','4837','THREE_DS_RECORD','RECOMMENDED'),
  ('MASTERCARD','4837','PRIOR_TRANSACTION_HISTORY','RECOMMENDED'),
  ('MASTERCARD','4855','PROOF_OF_DELIVERY','REQUIRED'),
  ('MASTERCARD','4855','PROOF_OF_SHIPPING','REQUIRED'),
  ('MASTERCARD','4853','PRODUCT_DESCRIPTION','RECOMMENDED'),
  ('MASTERCARD','4853','CUSTOMER_COMMUNICATION','RECOMMENDED'),
  ('MASTERCARD','4853','TERMS_ACCEPTED','RECOMMENDED'),
  ('MASTERCARD','4860','REFUND_RECORD','REQUIRED'),
  ('MASTERCARD','4808','AUTHORIZATION_RECORD','REQUIRED')
) AS v(network, code, kind, req)
JOIN reason_codes rc ON rc.network_code = v.network AND rc.code = v.code;
