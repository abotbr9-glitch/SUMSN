# إجابات خصوصية App Store المقترحة لـ SUMSN

هذه القائمة مبنية على التطبيق الحالي وسياسة الخصوصية. راجعها عند كل تغيير في الكود أو مزودي الخدمة.

## هل يجمع التطبيق بيانات؟

اختر: **Yes, we collect data from this app**.

## البيانات المرتبطة بالمستخدم — App Functionality

- Contact Info > Name
- Contact Info > Email Address
- Contact Info > Phone Number
- Contact Info > Physical Address
- Identifiers > User ID
- Purchases > Purchase History
- User Content > Customer Support
- User Content > Other User Content

الغرض: `App Functionality`. مرتبطة بهوية المستخدم: `Yes`. مستخدمة للتتبع: `No`.

يشمل Other User Content وصف محتويات الطرد والبيانات التي يدخلها العميل لإصدار الشحنة.

## بيانات غير مستخدمة للتتبع

- Usage Data > Product Interaction — Analytics، غير مرتبطة بالهوية عند استخدام السجلات الإحصائية المجمعة.
- Location > Coarse Location — Analytics/Security عند الاستدلال التقريبي من عنوان الشبكة أو حماية الإساءة، وليست GPS.

إذا أُزيل أي جمع فعلي لهذه البيانات من الخادم يمكن تحديث الإجابة لاحقًا، لكن لا ينبغي التقليل من الإفصاح الحالي.

## بيانات الدفع

- SUMSN لا يخزن رقم البطاقة أو CVV.
- TuwaiqPay يعالج الدفع الخاص ببوليصة الشحن الواقعية.
- SUMSN يحتفظ بمرجع العملية وحالتها ومبلغها كـ Purchase History لتنفيذ الشحنة والدعم والمحاسبة.
- لا تستخدم البيانات للإعلانات أو التتبع عبر التطبيقات.

## Tracking

اختر: **No, we do not use data for tracking**، ما دام التطبيق لا يضيف SDK إعلانيًا أو يربط بيانات المستخدم ببيانات طرف ثالث للإعلانات.

## الروابط

- Privacy Policy: `https://sumsn.com/privacy-policy.html`
- Privacy Choices / Account Deletion: `https://sumsn.com/account-deletion.html`
- Support: `https://sumsn.com/support.html`

## ملف Privacy Manifest

يوجد الملف داخل مشروع iOS في `ios/App/App/PrivacyInfo.xcprivacy`. يجب أن تبقى إجابات App Store Connect متوافقة معه، لكن ملف Manifest لا يغني عن تعبئة App Privacy يدويًا.
