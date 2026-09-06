 "use client";
 
 export default function VideoModal({ 
   isOpen, 
   onClose, 
   videoPath 
 }: { 
   isOpen: boolean; 
   onClose: () => void; 
   videoPath: string | null;
 }) {
   if (!isOpen || !videoPath) return null;
   
   const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
   const videoUrl = `${basePath}/api/videos/${encodeURIComponent(videoPath)}`;
   
   return (
     <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50" onClick={onClose}>
       <div className="bg-slate-900 rounded-xl p-4 max-w-4xl w-full mx-4 shadow-2xl" onClick={e => e.stopPropagation()}>
         <div className="flex justify-between items-center mb-3">
           <h3 className="text-white font-semibold">Xem video</h3>
           <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl">&times;</button>
         </div>
         <video controls className="w-full rounded-lg" src={videoUrl}>
           Browser does not support video.
         </video>
         <p className="text-slate-400 text-sm mt-2">{videoPath}</p>
       </div>
     </div>
   );
 }
